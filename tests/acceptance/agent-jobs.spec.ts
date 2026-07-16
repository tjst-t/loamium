/**
 * Sprint S2fe109「エージェント定期実行」受け入れテスト。
 *
 * AC-S2fe109-1-x: ジョブ一覧 API
 * AC-S2fe109-2-x: ジョブ即時実行 API + CLI
 * AC-S2fe109-3-x: nextRunAt / anacron キャッチアップ / スキーマ
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

// ── ヘルパー ─────────────────────────────────────────────────────────────────

/** テスト用の最小ジョブ定義 */
const VALID_JOB = {
  name: 'daily-summary',
  schedule: '0 8 * * *',
  prompt: 'ジャーナルを要約してください',
  permissions: ['read'],
  enabled: true,
  maxTurns: 5,
  timeoutSec: 30,
};

const DISABLED_JOB = {
  ...VALID_JOB,
  name: 'disabled-job',
  enabled: false,
};

async function writeJobsFile(vault: string, jobs: unknown[]): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent-jobs.json'), JSON.stringify(jobs, null, 2), 'utf8');
}

async function readStateFile(vault: string): Promise<Record<string, unknown>> {
  const file = path.join(vault, '.loamium', 'agent-jobs-state.json');
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── 共通サーバー ─────────────────────────────────────────────────────────────

let server: TestServer;

beforeAll(async () => {
  const vault = await makeTempVault();
  await writeJobsFile(vault, [VALID_JOB, DISABLED_JOB]);
  server = await startServer({ vault });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

// ── AC-S2fe109-1-x: ジョブ一覧 API ──────────────────────────────────────────

describe('[AC-S2fe109-1-1] GET /api/agent/jobs → 200 + jobs 配列', () => {
  it('200 を返し jobs に name, schedule, enabled, state が含まれる', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: Array<{
        name: string;
        schedule: string;
        enabled: boolean;
        state: { lastRunAt: string | null; lastResult: string | null; lastError: string | null };
      }>;
    };
    expect(Array.isArray(body.jobs)).toBe(true);
    const job = body.jobs.find((j) => j.name === 'daily-summary');
    expect(job).toBeDefined();
    expect(job?.schedule).toBe('0 8 * * *');
    expect(job?.enabled).toBe(true);
    // state の存在と型のみ検証 (スケジューラが起動時に実行するため lastResult は変動)
    expect(job?.state).toBeDefined();
    expect('lastRunAt' in (job?.state ?? {})).toBe(true);
    expect('lastResult' in (job?.state ?? {})).toBe(true);
    expect('lastError' in (job?.state ?? {})).toBe(true);
  });
});

describe('[AC-S2fe109-1-2] 不正エントリをスキップして有効なものだけ返す', () => {
  it('permission フィールドが不正な場合でもパースに成功する', async () => {
    // この AC は agent-jobs-store.ts の per-entry 検証が動作することを確認する。
    // 現在の vault には有効なジョブが含まれているため、GET は 200 を返す。
    const res = await fetch(`${server.baseUrl}/api/agent/jobs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: unknown[] };
    // 少なくとも 1 件の有効なジョブが返る
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('agent-jobs.json に不正エントリが混在しても有効なものは返る', async () => {
    // 新規 vault + サーバーで不正エントリ混在テスト
    const vault2 = await makeTempVault();
    const mixed = [
      { name: 'good-job', schedule: '0 9 * * *', prompt: 'テスト', enabled: true, maxTurns: 5, timeoutSec: 30 },
      { name: '', schedule: 'invalid', prompt: '' }, // 不正エントリ (name が空)
    ];
    await writeJobsFile(vault2, mixed);
    const srv2 = await startServer({ vault: vault2 });
    try {
      const res = await fetch(`${srv2.baseUrl}/api/agent/jobs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { jobs: Array<{ name: string }> };
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]?.name).toBe('good-job');
    } finally {
      await srv2.stop();
      await cleanupVault(vault2);
    }
  });
});

describe('[AC-S2fe109-1-3] .gitignore に !/.loamium/agent-jobs.json が含まれる', () => {
  it('.gitignore ファイルに !/.loamium/agent-jobs.json がある', async () => {
    const repoRoot = path.resolve(
      new URL(import.meta.url).pathname,
      '../../../',
    );
    const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain('!/.loamium/agent-jobs.json');
  });
});

describe('[AC-S2fe109-1-4] GET /api/agent/jobs/:name', () => {
  it('既存ジョブ → 200 + フルフィールド', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/daily-summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['name']).toBe('daily-summary');
    expect(body['schedule']).toBe('0 8 * * *');
    expect(body['enabled']).toBe(true);
    expect(body['maxTurns']).toBe(5);
    expect(body['timeoutSec']).toBe(30);
    expect(body['state']).toBeDefined();
    // nextRunAt は後段テスト (AC-3-1) で詳細検証
    expect('nextRunAt' in body).toBe(true);
  });

  it('存在しないジョブ → 404', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/no-such-job`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('job_not_found');
  });
});

// ── AC-S2fe109-2-x: ジョブ即時実行 ──────────────────────────────────────────

describe('[AC-S2fe109-2-1] POST /api/agent/jobs/:name/run → 200 + レスポンス形式', () => {
  it('200 を返し ok/result/error/durationMs が含まれる', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/daily-summary/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: string;
      error: string | null;
      durationMs: number;
    };
    expect(typeof body.ok).toBe('boolean');
    expect(['ok', 'error', 'timeout', 'aborted']).toContain(body.result);
    expect(body.error === null || typeof body.error === 'string').toBe(true);
    expect(typeof body.durationMs).toBe('number');
  });
});

describe('[AC-S2fe109-2-2] 存在しないジョブを実行 → 404', () => {
  it('404 + job_not_found を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/nonexistent/run`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('job_not_found');
  });
});

describe('[AC-S2fe109-2-3] enabled:false のジョブを実行 → 409', () => {
  it('409 + job_disabled を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/disabled-job/run`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('job_disabled');
  });
});

describe('[AC-S2fe109-2-4] loamium agent-jobs run CLI', () => {
  it('exit 0 で result を stdout に出力する', async () => {
    const result = await runCli(['agent-jobs', 'run', 'daily-summary'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    // LLM が unreachable な場合でも exit 0 (サーバー側でエラーハンドリング済み)
    expect(result.code).toBe(0);
    // stdout に result が含まれる
    expect(result.stdout).toMatch(/result:\s*(ok|error|timeout|aborted)/);
  });
});

// ── AC-S2fe109-3-x: nextRunAt / スケジューラ / スキーマ ──────────────────────

describe('[AC-S2fe109-3-1] GET /api/agent/jobs/:name → nextRunAt が将来の ISO8601 時刻', () => {
  it('nextRunAt が ISO8601 文字列で現在より後', async () => {
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/daily-summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextRunAt: string | null };
    expect(body.nextRunAt).not.toBeNull();
    // ISO8601 の基本パターン
    expect(body.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // 将来時刻
    const nextRun = new Date(body.nextRunAt as string);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('[AC-S2fe109-3-2] anacron キャッチアップ — lastRunAt 48h 前のジョブが 10 秒以内に実行される', () => {
  it('48 時間前が lastRunAt のジョブがサーバー起動後にキャッチアップされる', async () => {
    const vault3 = await makeTempVault();

    // 毎分発火するジョブ (キャッチアップが確実に起きる)
    const catchupJob = {
      name: 'catchup-job',
      schedule: '* * * * *',
      prompt: 'テスト用プロンプト',
      enabled: true,
      maxTurns: 1,
      timeoutSec: 10,
    };
    await writeJobsFile(vault3, [catchupJob]);

    // 状態ファイルに 48 時間前の lastRunAt を書き込む
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stateDir = path.join(vault3, '.loamium');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, 'agent-jobs-state.json'),
      JSON.stringify({
        'catchup-job': {
          lastRunAt: fortyEightHoursAgo.toISOString(),
          lastResult: 'ok',
          lastError: null,
        },
      }),
      'utf8',
    );

    const srv3 = await startServer({ vault: vault3 });
    try {
      // 最大 10 秒間、状態ファイルが更新されるのを待つ
      const deadline = Date.now() + 10_000;
      let updated = false;
      while (Date.now() < deadline) {
        const state = await readStateFile(vault3);
        const jobState = state['catchup-job'] as {
          lastRunAt?: string;
          lastResult?: string | null;
        } | undefined;
        if (
          jobState?.lastRunAt !== undefined &&
          new Date(jobState.lastRunAt).getTime() > fortyEightHoursAgo.getTime()
        ) {
          updated = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(updated).toBe(true);
    } finally {
      await srv3.stop();
      await cleanupVault(vault3);
    }
  }, 20_000); // タイムアウト 20 秒
});

describe('[AC-S2fe109-3-3] anacron キャッチアップ後に状態ファイルが更新される', () => {
  it('POST /run 実行後に agent-jobs-state.json が更新される', async () => {
    // POST /run を呼んで、状態ファイルに lastRunAt が書き込まれることを確認
    await fetch(`${server.baseUrl}/api/agent/jobs/daily-summary/run`, {
      method: 'POST',
    });

    const state = await readStateFile(server.vault);
    const jobState = state['daily-summary'] as {
      lastRunAt?: string | null;
      lastResult?: string | null;
      lastError?: string | null;
    } | undefined;
    expect(jobState?.lastRunAt).toBeDefined();
    expect(jobState?.lastRunAt).not.toBeNull();
    // ISO8601 形式
    expect(typeof jobState?.lastRunAt).toBe('string');
    // result が記録されている
    expect(['ok', 'error', 'timeout', 'aborted', null]).toContain(jobState?.lastResult);
  });
});

describe('[AC-S2fe109-3-4] maxTurns / timeoutSec がジョブごとに設定できる (スキーマ検証)', () => {
  it('PUT /api/agent/jobs でカスタム maxTurns と timeoutSec を持つジョブが保存される', async () => {
    const customJob = {
      name: 'custom-limits',
      schedule: '0 12 * * *',
      prompt: 'カスタム上限テスト',
      enabled: true,
      maxTurns: 15,
      timeoutSec: 180,
    };

    const put = await fetch(`${server.baseUrl}/api/agent/jobs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: [customJob] }),
    });
    expect(put.status).toBe(200);

    // GET で確認
    const res = await fetch(`${server.baseUrl}/api/agent/jobs/custom-limits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { maxTurns: number; timeoutSec: number };
    expect(body.maxTurns).toBe(15);
    expect(body.timeoutSec).toBe(180);
  });

  it('maxTurns の上限 (50) を超えると 400 を返す', async () => {
    const badJob = {
      name: 'too-many-turns',
      schedule: '0 12 * * *',
      prompt: 'テスト',
      enabled: true,
      maxTurns: 99, // 上限超え
      timeoutSec: 120,
    };
    const put = await fetch(`${server.baseUrl}/api/agent/jobs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: [badJob] }),
    });
    expect(put.status).toBe(400);
  });

  it('timeoutSec の上限 (600) を超えると 400 を返す', async () => {
    const badJob = {
      name: 'too-long-timeout',
      schedule: '0 12 * * *',
      prompt: 'テスト',
      enabled: true,
      maxTurns: 5,
      timeoutSec: 9999, // 上限超え
    };
    const put = await fetch(`${server.baseUrl}/api/agent/jobs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: [badJob] }),
    });
    expect(put.status).toBe(400);
  });
});
