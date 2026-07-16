/**
 * エージェントジョブ即時実行 API 受け入れテスト (S2fe109-2)
 *
 * [AC-S2fe109-2-1] POST /api/agent/jobs/:name/run で enabled なジョブを実行 → 200 + sessionId
 * [AC-S2fe109-2-2] 存在しないジョブ名 → 404 + error フィールド
 * [AC-S2fe109-2-3] enabled: false のジョブ → 409 + error に 'disabled' を含む
 *
 * AC-S2fe109-2-4 (loamium agent-run <name>):
 *   CLI バイナリのビルドが必要なため、ここでは HTTP API テストのみ実施する。
 *   TODO: `make build` でバイナリをビルドし、child_process.spawn で
 *   `loamium agent-run test-job` を実行して exit code 0 と stdout の sessionId を確認すること。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
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
  // Use an unreachable baseUrl so the session is created but the LLM call fails.
  // This tests session creation, not LLM completion.
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

describe('agent-jobs-run', () => {
  let server: TestServer;
  let vault: string;

  beforeEach(async () => {
    vault = await makeTempVault();
  });

  afterEach(async () => {
    await server?.stop();
    await cleanupVault(vault);
  });

  it('POST /api/agent/jobs/:name/run returns 200 with sessionId and session is queryable (AC-S2fe109-2-1)', async () => {
    // [AC-S2fe109-2-1]
    await seedAgentConfig(vault);
    await seedAgentJobs(vault, [
      {
        name: 'test-job',
        schedule: '0 9 * * *',
        prompt: 'Summarize recent notes',
        permission: 'read-only',
        enabled: true,
      },
    ]);

    server = await startServer({ vault });

    const runRes = await fetch(`${server.baseUrl}/api/agent/jobs/test-job/run`, {
      method: 'POST',
    });

    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as unknown;
    expect(runBody).toHaveProperty('sessionId');
    expect(typeof (runBody as { sessionId: unknown }).sessionId).toBe('string');
    expect((runBody as { sessionId: string }).sessionId.length).toBeGreaterThan(0);

    const { sessionId } = runBody as { sessionId: string };

    // Session should be queryable via GET /api/agent/sessions/{sessionId}
    const sessionRes = await fetch(`${server.baseUrl}/api/agent/sessions/${sessionId}`);
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { id: string };
    expect(sessionBody.id).toBe(sessionId);
  });

  it('POST /api/agent/jobs/nonexistent/run returns 404 with error field (AC-S2fe109-2-2)', async () => {
    // [AC-S2fe109-2-2]
    await seedAgentConfig(vault);
    await seedAgentJobs(vault, []);

    server = await startServer({ vault });

    const res = await fetch(`${server.baseUrl}/api/agent/jobs/nonexistent/run`, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: unknown };
    expect(body).toHaveProperty('error');
  });

  it('POST /api/agent/jobs/:name/run with disabled job returns 409 with error containing "disabled" (AC-S2fe109-2-3)', async () => {
    // [AC-S2fe109-2-3]
    await seedAgentConfig(vault);
    await seedAgentJobs(vault, [
      {
        name: 'disabled-job',
        schedule: '0 9 * * *',
        prompt: 'Some task',
        permission: 'read-only',
        enabled: false,
      },
    ]);

    server = await startServer({ vault });

    const res = await fetch(`${server.baseUrl}/api/agent/jobs/disabled-job/run`, {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect((body.error ?? '').toLowerCase()).toContain('disabled');
  });
});
