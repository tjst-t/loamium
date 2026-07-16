/**
 * POST /api/commands/{name}/run の agent-run ステップ分岐テスト (S5a66e4-3)。
 *
 * runAgentJob をスタブして ok / error / timeout を注入し、以下を検証する:
 *   (a) 正常時 ok:true (path は省略 = エージェント任せ)
 *   (b) error 時 ok:false かつ後続ステップ未実行 (fail-stop, ADR-0021)
 *   (c) append-only モードで agent-run を含むコマンドは 403
 *   (d) when:false のとき agent を起動せずスキップ ({ok:true, skipped:true})
 *   (e) timeout 時 ok:false
 *
 * 既存 6 種のステップ実行は不変 (このファイルでは agent-run 分岐のみを対象)。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentJob, JobRunResult } from '@loamium/shared';
import type { ServerConfig as ServerConfigType } from '../config.js';
import type { VaultIndex as VaultIndexType } from '../noteIndex.js';

// runAgentJob をモックする。commands.ts はこのモジュールから import しているため、
// ルート内の呼び出しがスタブへ差し替わる。シグネチャは本物と一致させる。
// vi.mock ファクトリはファイル先頭へ巻き上げられるため、モック関数は vi.hoisted で
// 生成し初期化順の問題を避ける。
const { runAgentJobMock } = vi.hoisted(() => ({
  runAgentJobMock: vi.fn<
    (
      config: ServerConfigType,
      index: VaultIndexType,
      job: AgentJob,
    ) => Promise<{ result: JobRunResult; error: string | null }>
  >(),
}));
vi.mock('../agent-job-runner.js', () => ({
  runAgentJob: runAgentJobMock,
}));

import { createApp } from '../app.js';
import { VaultIndex } from '../noteIndex.js';
import type { ServerConfig } from '../config.js';

interface RunResultBody {
  results: { kind: string; ok: boolean; path?: string; error?: string; skipped?: boolean }[];
  openPath?: string;
}

async function makeApp(mode: ServerConfig['mode']): Promise<{
  app: ReturnType<typeof createApp>;
  vaultRoot: string;
}> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-commands-agentrun-'));
  await mkdir(path.join(vaultRoot, 'system', 'commands'), { recursive: true });
  await mkdir(path.join(vaultRoot, '.loamium'), { recursive: true });

  // agent-run 単独コマンド
  await writeFile(
    path.join(vaultRoot, 'system', 'commands', 'summarize.yaml'),
    ['name: summarize', 'steps:', '  - kind: agent-run', '    prompt: "{{topic}} を要約して"'].join('\n'),
    'utf8',
  );

  // agent-run のあとに journal-append を置き fail-stop を観測できるコマンド
  await writeFile(
    path.join(vaultRoot, 'system', 'commands', 'summarize-then-log.yaml'),
    [
      'name: summarize-then-log',
      'params:',
      '  - name: topic',
      'steps:',
      '  - kind: agent-run',
      '    prompt: "{{topic}} を要約して"',
      '  - kind: journal-append',
      '    content: "logged"',
    ].join('\n'),
    'utf8',
  );

  // when 条件付き agent-run (when が falsey ならスキップ)
  await writeFile(
    path.join(vaultRoot, 'system', 'commands', 'maybe-summarize.yaml'),
    [
      'name: maybe-summarize',
      'params:',
      '  - name: go',
      'steps:',
      '  - kind: agent-run',
      '    prompt: "要約して"',
      '    when: "{{go}}"',
    ].join('\n'),
    'utf8',
  );

  const index = new VaultIndex(vaultRoot);
  await index.build();
  const config: ServerConfig = { vaultRoot, mode, maxUploadBytes: 1024 };
  return { app: createApp(config, index), vaultRoot };
}

async function postRun(
  app: ReturnType<typeof createApp>,
  name: string,
  params: Record<string, string>,
): Promise<Response> {
  return app.request(`/api/commands/${name}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  });
}

describe('POST /api/commands/{name}/run — agent-run 分岐 (S5a66e4-3)', () => {
  let vaultRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    runAgentJobMock.mockReset();
    const made = await makeApp('full');
    app = made.app;
    vaultRoot = made.vaultRoot;
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('(a) runAgentJob ok → ステップ ok:true (path 省略) [AC-S5a66e4-3-2]', async () => {
    runAgentJobMock.mockResolvedValue({ result: 'ok', error: null });
    const res = await postRun(app, 'summarize', { topic: '議事録' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunResultBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ kind: 'agent-run', ok: true });
    expect(body.results[0]?.path).toBeUndefined();
    expect(runAgentJobMock).toHaveBeenCalledTimes(1);

    // prompt が resolveTemplate で展開されて渡ること
    const jobArg = runAgentJobMock.mock.calls[0]?.[2];
    expect(jobArg?.prompt).toBe('議事録 を要約して');
  });

  it('(b) runAgentJob error → ステップ ok:false かつ後続ステップ未実行 (fail-stop) [AC-S5a66e4-3-2]', async () => {
    runAgentJobMock.mockResolvedValue({ result: 'error', error: 'agent 未設定' });
    const res = await postRun(app, 'summarize-then-log', { topic: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunResultBody;
    // agent-run のみが results に残り、journal-append は実行されない
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.kind).toBe('agent-run');
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.error).toContain('agent job error');
    expect(body.results[0]?.error).toContain('agent 未設定');
  });

  it('(e) runAgentJob timeout → ステップ ok:false', async () => {
    runAgentJobMock.mockResolvedValue({ result: 'timeout', error: 'タイムアウト (120s)' });
    const res = await postRun(app, 'summarize', { topic: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunResultBody;
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.error).toContain('agent job timeout');
  });

  it('(d) when:false → agent を起動せずスキップ [AC-S5a66e4-3-4]', async () => {
    runAgentJobMock.mockResolvedValue({ result: 'ok', error: null });
    // go="" は falsey → スキップ
    const res = await postRun(app, 'maybe-summarize', { go: '' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunResultBody;
    expect(body.results[0]).toMatchObject({ kind: 'agent-run', ok: true, skipped: true });
    expect(runAgentJobMock).not.toHaveBeenCalled();
  });

  it('(d) when:true → agent を起動する', async () => {
    runAgentJobMock.mockResolvedValue({ result: 'ok', error: null });
    const res = await postRun(app, 'maybe-summarize', { go: 'yes' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunResultBody;
    expect(body.results[0]).toMatchObject({ kind: 'agent-run', ok: true });
    expect(body.results[0]?.skipped).toBeUndefined();
    expect(runAgentJobMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/commands/{name}/run — agent-run in append-only (S5a66e4-3)', () => {
  let vaultRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    runAgentJobMock.mockReset();
    const made = await makeApp('append-only');
    app = made.app;
    vaultRoot = made.vaultRoot;
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('(c) append-only で agent-run を含むコマンドは 403 かつ agent 未起動 [AC-S5a66e4-3-3]', async () => {
    runAgentJobMock.mockResolvedValue({ result: 'ok', error: null });
    const res = await postRun(app, 'summarize', { topic: 'x' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
    expect(runAgentJobMock).not.toHaveBeenCalled();
  });
});
