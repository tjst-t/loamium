/**
 * エージェントジョブスケジューラ受け入れテスト (S2fe109-3)
 *
 * [AC-S2fe109-3-1] cron schedule を持つジョブの nextRunAt が ISO8601 将来時刻として返される
 * [AC-S2fe109-3-2] anacron キャッチアップ: 前回実行が 48 時間前のジョブが起動後 30 秒以内に実行される
 * [AC-S2fe109-3-3] ジョブ実行後、agent-job-state.json の lastRunAt が更新される
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';

async function seedAgentJobs(vault: string, content: unknown): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent-jobs.json'), JSON.stringify(content), 'utf8');
}

async function seedAgentConfig(vault: string): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'agent.json'),
    JSON.stringify({
      api: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-4o',
      apiKey: 'dummy-key',
    }),
    'utf8',
  );
}

async function seedJobState(vault: string, jobName: string, lastRunAt: string): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  const state = { jobs: { [jobName]: { lastRunAt } } };
  await writeFile(path.join(dir, 'agent-job-state.json'), JSON.stringify(state), 'utf8');
}

describe('agent-jobs-scheduler', () => {
  let server: TestServer;
  let vault: string;

  beforeEach(async () => {
    vault = await makeTempVault();
  });

  afterEach(async () => {
    await server?.stop();
    await cleanupVault(vault);
  });

  it(
    'GET /api/agent/jobs/:name returns nextRunAt as ISO8601 future datetime (AC-S2fe109-3-1)',
    async () => {
      // [AC-S2fe109-3-1]
      await seedAgentJobs(vault, [
        {
          name: 'sched-job',
          schedule: '0 7 * * *',
          prompt: 'Daily summary',
          permission: 'read-only',
          enabled: true,
        },
      ]);

      server = await startServer({ vault });

      const res = await fetch(`${server.baseUrl}/api/agent/jobs/sched-job`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        name: string;
        nextRunAt: string | null;
        schedule: string;
        enabled: boolean;
      };

      expect(body.name).toBe('sched-job');
      expect(typeof body.nextRunAt).toBe('string');
      expect(body.nextRunAt).not.toBeNull();

      const nextRunAt = new Date(body.nextRunAt!);
      expect(Number.isNaN(nextRunAt.getTime())).toBe(false);
      expect(nextRunAt.getTime()).toBeGreaterThan(Date.now());
    },
    30_000,
  );

  it(
    'anacron catchup: job with lastRunAt 48h ago fires within 10s and state file is updated (AC-S2fe109-3-2 + AC-S2fe109-3-3)',
    async () => {
      // [AC-S2fe109-3-2] [AC-S2fe109-3-3]
      const testStart = new Date();
      const lastRunAt48hAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      await seedAgentConfig(vault);
      await seedAgentJobs(vault, [
        {
          name: 'catchup-job',
          schedule: '0 7 * * *',
          prompt: 'Catchup task',
          permission: 'read-only',
          enabled: true,
        },
      ]);
      await seedJobState(vault, 'catchup-job', lastRunAt48hAgo);

      server = await startServer({ vault });

      // Poll for up to 10 seconds for a session to appear
      const deadline = Date.now() + 10_000;
      let sessions: { id: string; title: string | null; updatedAt: number }[] = [];
      while (Date.now() < deadline) {
        const res = await fetch(`${server.baseUrl}/api/agent/sessions`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { sessions: typeof sessions };
        sessions = body.sessions;
        if (sessions.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(sessions.length).toBeGreaterThan(0);

      // Verify agent-job-state.json was updated
      const stateFile = path.join(vault, '.loamium', 'agent-job-state.json');
      let stateRaw: string;
      try {
        stateRaw = await readFile(stateFile, 'utf8');
      } catch {
        throw new Error('agent-job-state.json was not written by the scheduler');
      }

      const state = JSON.parse(stateRaw) as {
        jobs: Record<string, { lastRunAt: string }>;
      };

      const updatedLastRunAt = state.jobs['catchup-job']?.lastRunAt;
      expect(typeof updatedLastRunAt).toBe('string');

      const updatedAt = new Date(updatedLastRunAt!);
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(testStart.getTime());
    },
    30_000,
  );
});
