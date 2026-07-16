/**
 * エージェントジョブ定義 API 受け入れテスト (S2fe109-1)
 *
 * [AC-S2fe109-1-1] GET /api/agent/jobs → 200 + ジョブ一覧
 * [AC-S2fe109-1-2] 不正エントリはスキップされ、正常エントリのみ返す
 * [AC-S2fe109-1-3] .gitignore に !.loamium/agent-jobs.json が含まれる
 * [AC-S2fe109-1-4] GET /api/agent/jobs/:name → 詳細 / 存在しない場合は 404
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');

async function seedAgentJobs(vault: string, content: unknown): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent-jobs.json'), JSON.stringify(content), 'utf8');
}

describe('agent-jobs-schema', () => {
  let server: TestServer;
  let vault: string;

  beforeEach(async () => {
    vault = await makeTempVault();
  });

  afterEach(async () => {
    await server?.stop();
    await cleanupVault(vault);
  });

  it('returns job list with correct fields (AC-S2fe109-1-1)', async () => {
    // [AC-S2fe109-1-1]
    await seedAgentJobs(vault, [
      {
        name: 'daily-summary',
        schedule: '0 9 * * *',
        prompt: 'Summarize notes',
        permission: 'read-only',
        enabled: true,
      },
    ]);

    server = await startServer({ vault });
    const res = await fetch(`${server.baseUrl}/api/agent/jobs`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ name: string; schedule: string; enabled: boolean; lastRunAt: string | null }> };
    expect(body).toHaveProperty('jobs');
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);

    const job = body.jobs.find((j) => j.name === 'daily-summary');
    expect(job).toBeDefined();
    expect(job?.schedule).toBe('0 9 * * *');
    expect(job?.enabled).toBe(true);
    expect('lastRunAt' in (job ?? {})).toBe(true);
    expect(job?.lastRunAt).toBeNull();
  });

  it('skips invalid entries and returns valid ones (AC-S2fe109-1-2)', async () => {
    // [AC-S2fe109-1-2]
    await seedAgentJobs(vault, [
      {
        name: 'good-job',
        schedule: '0 8 * * *',
        prompt: 'Do good work',
        permission: 'read-only',
        enabled: true,
      },
      {
        schedule: '0 9 * * *',
        prompt: 'Missing name field',
        permission: 'invalid-permission',
        enabled: false,
      },
    ]);

    server = await startServer({ vault });
    const res = await fetch(`${server.baseUrl}/api/agent/jobs`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ name: string }> };
    const names = body.jobs.map((j) => j.name);
    expect(names).toContain('good-job');
    expect(names).not.toContain(undefined);
    expect(body.jobs.length).toBe(1);
  });

  it('returns job detail and 404 for unknown name (AC-S2fe109-1-4)', async () => {
    // [AC-S2fe109-1-4]
    await seedAgentJobs(vault, [
      {
        name: 'daily-summary',
        schedule: '0 9 * * *',
        prompt: 'Summarize notes',
        permission: 'read-only',
        enabled: true,
      },
    ]);

    server = await startServer({ vault });

    const detailRes = await fetch(`${server.baseUrl}/api/agent/jobs/daily-summary`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      name: string;
      schedule: string;
      prompt: string;
      permission: string;
      enabled: boolean;
      lastRunAt: string | null;
      nextRunAt: string | null;
    };
    expect(detail.name).toBe('daily-summary');
    expect(detail.schedule).toBe('0 9 * * *');
    expect(detail.prompt).toBe('Summarize notes');
    expect(detail.permission).toBe('read-only');
    expect(detail.enabled).toBe(true);
    expect('lastRunAt' in detail).toBe(true);
    expect('nextRunAt' in detail).toBe(true);

    const notFoundRes = await fetch(`${server.baseUrl}/api/agent/jobs/nonexistent`);
    expect(notFoundRes.status).toBe(404);
  });

  it('.gitignore contains !.loamium/agent-jobs.json (AC-S2fe109-1-3)', async () => {
    // [AC-S2fe109-1-3]
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const content = await readFile(gitignorePath, 'utf8');
    expect(content).toContain('!/.loamium/agent-jobs.json');

    server = await startServer({ vault });
  });
});
