/**
 * エージェントジョブ API ルート (S2fe109)。
 *
 * GET  /api/agent/jobs              ジョブ一覧 + 状態 → { jobs }
 * GET  /api/agent/jobs/:name        ジョブ詳細 + 状態 + nextRunAt → AgentJobDetailResponse
 * PUT  /api/agent/jobs              ジョブ一覧を全置換 → { ok }
 * POST /api/agent/jobs/:name/run    ジョブ即時実行 → { ok, result, error, durationMs }
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { loadAgentJobs, loadJobsState, saveJobState } from '../agent-jobs-store.js';
import { runAgentJob } from '../agent-job-runner.js';
import { computeNextRunAt } from '../agent-scheduler.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { z } from 'zod';
import { agentJobsSchema } from '@loamium/shared';

export function agentJobRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- GET /api/agent/jobs ---------------------------------------------------

  app.get('/api/agent/jobs', async (c) => {
    let jobs;
    try {
      jobs = await loadAgentJobs(config.vaultRoot);
    } catch (err) {
      return errorJson(c, 400, 'invalid_jobs_file', String(err));
    }
    const state = await loadJobsState(config.vaultRoot);
    const withState = jobs.map((job) => ({
      ...job,
      state: state[job.name] ?? { lastRunAt: null, lastResult: null, lastError: null },
    }));
    return c.json({ jobs: withState });
  });

  // ---- GET /api/agent/jobs/:name --------------------------------------------

  app.get('/api/agent/jobs/:name', async (c) => {
    const name = c.req.param('name');
    let jobs;
    try {
      jobs = await loadAgentJobs(config.vaultRoot);
    } catch (err) {
      return errorJson(c, 400, 'invalid_jobs_file', String(err));
    }
    const job = jobs.find((j) => j.name === name);
    if (!job) {
      return errorJson(c, 404, 'job_not_found', `ジョブ "${name}" が見つかりません`);
    }
    const state = await loadJobsState(config.vaultRoot);
    const jobState = state[name] ?? { lastRunAt: null, lastResult: null, lastError: null };
    const nextRunAt = computeNextRunAt(job.schedule);
    return c.json({ ...job, state: jobState, nextRunAt });
  });

  // ---- PUT /api/agent/jobs ---------------------------------------------------
  // ジョブ定義を全置換 (UI からの保存)。agent-jobs.json を上書きする。

  app.put('/api/agent/jobs', async (c) => {
    const bodySchema = z.object({ jobs: agentJobsSchema });
    const bodyResult = await parseBody(c, bodySchema);
    if (!bodyResult.ok) return bodyResult.response;

    const { jobs } = bodyResult.data;
    const file = path.join(config.vaultRoot, '.loamium', 'agent-jobs.json');
    const dir = path.dirname(file);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await fs.writeFile(file, JSON.stringify(jobs, null, 2), 'utf8');

    setAudit(c, 'agent.jobs.write', '.loamium/agent-jobs.json');
    return c.json({ ok: true, count: jobs.length });
  });

  // ---- POST /api/agent/jobs/:name/run ----------------------------------------

  app.post('/api/agent/jobs/:name/run', async (c) => {
    const name = c.req.param('name');

    let jobs;
    try {
      jobs = await loadAgentJobs(config.vaultRoot);
    } catch (err) {
      return errorJson(c, 400, 'invalid_jobs_file', String(err));
    }

    const job = jobs.find((j) => j.name === name);
    if (!job) {
      return errorJson(c, 404, 'job_not_found', `ジョブ "${name}" が見つかりません`);
    }
    if (!job.enabled) {
      return errorJson(c, 409, 'job_disabled', `ジョブ "${name}" は無効化されています`);
    }

    setAudit(c, 'agent.job.run', name);

    const startedAt = new Date();

    // 最終実行時刻を先に記録 (スケジューラによる二重実行を防ぐ)
    await saveJobState(config.vaultRoot, name, {
      lastRunAt: startedAt.toISOString(),
      lastResult: null,
      lastError: null,
    });

    const start = Date.now();
    let result: 'ok' | 'error' | 'timeout' | 'aborted' = 'ok';
    let error: string | null = null;

    try {
      ({ result, error } = await runAgentJob(config, index, job));
    } catch (err) {
      result = 'error';
      error = String(err);
    }

    const durationMs = Date.now() - start;

    await saveJobState(config.vaultRoot, name, {
      lastRunAt: startedAt.toISOString(),
      lastResult: result,
      lastError: error,
    });

    return c.json({ ok: result === 'ok', result, error, durationMs });
  });

  return app;
}
