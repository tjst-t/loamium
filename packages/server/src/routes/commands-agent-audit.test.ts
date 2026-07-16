/**
 * agent-run を含むコマンド実行の監査ログ二重記録 integration テスト (S5a66e4-4)。
 *
 * [AC-S5a66e4-4-3] agent-run ステップを含む command run で、監査ログ
 * (.loamium/audit.log) に command 実行 (command.run + agent-run.step) と
 * agent 側書き込み (agent.journal_append) の双方が残ること、および書き込みが
 * vault ルート内に限定される (vault 外は既存サービス層が拒否) ことを検証する。
 *
 * runAgentJob はスタブしてよい (AC-4-3 明記) が、監査記録経路は本物を通す:
 * スタブは実際のエージェントが journal_append ツールで書き込む挙動を模し、
 * (1) 当日ジャーナルへ writeNote で追記し、(2) 本物の writeAuditEntry で
 * agent.journal_append エントリを .loamium/audit.log に残す。
 * これにより commands.ts 側の command.run / agent-run.step 監査と、agent 側
 * 書き込み監査が同一 audit.log に共存することを本物の経路で観測できる。
 *
 * 既存テスト (commands.test.ts など) は不変。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentJob, JobRunResult, AuditEntry } from '@loamium/shared';
import type { ServerConfig as ServerConfigType } from '../config.js';
import type { VaultIndex as VaultIndexType } from '../noteIndex.js';

// runAgentJob をスタブする。ただし監査経路は本物を通すため、スタブ内で
// 実 writeNote + 実 writeAuditEntry を呼び「エージェントが journal_append
// ツールで書いた」状態を再現する。
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
import { writeNote } from '../vault.js';
import { writeAuditEntry } from '../audit.js';
import {
  todayJournalDate,
  journalPath,
  insertUnderHeading,
  parseLoamiumCommandFileWithError,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';

/** リポジトリ同梱サンプル (make samples の正本) の絶対パス */
const SAMPLE_MEETING_SUMMARY = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'samples',
  'commands',
  'meeting-summary.yaml',
);

async function makeApp(): Promise<{ app: ReturnType<typeof createApp>; vaultRoot: string; config: ServerConfig }> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-cmd-agent-audit-'));
  await mkdir(path.join(vaultRoot, 'system', 'commands'), { recursive: true });
  await mkdir(path.join(vaultRoot, '.loamium'), { recursive: true });

  // meeting-summary サンプル相当のコマンドを配置する (source ノート要約 → journal 追記)。
  await writeFile(
    path.join(vaultRoot, 'system', 'commands', 'meeting-summary.yaml'),
    [
      'name: 議事録まとめ',
      'params:',
      '  - name: source',
      '    type: note',
      '    required: true',
      '  - name: section',
      '    default: 議事録',
      'steps:',
      '  - kind: agent-run',
      '    prompt: |',
      '      ノート「{{source}}」を要約し journal の「{{section}}」セクションへ',
      '      journal_append で追記してください。',
    ].join('\n'),
    'utf8',
  );

  // 要約対象の source ノート
  await writeNote(vaultRoot, 'meetings/2026-07-16.md', '# 定例\n- A を決定\n- B を宿題\n');

  const index = new VaultIndex(vaultRoot);
  await index.build();
  const config: ServerConfig = { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
  return { app: createApp(config, index), vaultRoot, config };
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

async function readAuditEntries(vaultRoot: string): Promise<AuditEntry[]> {
  const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditEntry);
}

describe('agent-run を含む command run の監査ログ二重記録 (S5a66e4-4) [AC-S5a66e4-4-3]', () => {
  let vaultRoot: string;
  let config: ServerConfig;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    runAgentJobMock.mockReset();
    const made = await makeApp();
    app = made.app;
    vaultRoot = made.vaultRoot;
    config = made.config;
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('同梱サンプル samples/commands/meeting-summary.yaml が有効で source(note)/section(既定=議事録)/agent-run を持つ [AC-S5a66e4-4-2]', async () => {
    const content = await readFile(SAMPLE_MEETING_SUMMARY, 'utf8');
    const parsed = parseLoamiumCommandFileWithError(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cmd = parsed.command;
    const source = cmd.params.find((p) => p.name === 'source');
    expect(source?.type).toBe('note');
    expect(source?.required).toBe(true);
    const section = cmd.params.find((p) => p.name === 'section');
    expect(section?.default).toBe('議事録');
    const step = cmd.steps.find((s) => s.kind === 'agent-run');
    expect(step).toBeDefined();
    if (step?.kind === 'agent-run') {
      // prompt が source を読み section へ journal_append する指示であること
      expect(step.prompt).toContain('{{source}}');
      expect(step.prompt).toContain('{{section}}');
      expect(step.prompt).toContain('journal_append');
    }
  });

  it('command.run + agent-run.step + agent.journal_append の 3 エントリが audit.log に残る', async () => {
    // スタブ: 実際の journal_append ツール委譲を模して vault 内へ書き、監査を本物で残す。
    runAgentJobMock.mockImplementation(async (cfg, _index, job) => {
      expect(job.prompt).toContain('を要約し journal の「議事録」セクションへ');
      const dateStr = todayJournalDate(new Date());
      const rel = journalPath(dateStr);
      const existing = (await readFile(path.join(cfg.vaultRoot, rel), 'utf8').catch(() => '')) || '';
      const next = insertUnderHeading(existing, '議事録', '- A を決定 / B を宿題');
      await writeNote(cfg.vaultRoot, rel, next);
      await writeAuditEntry(cfg, {
        ts: new Date().toISOString(),
        op: 'agent.journal_append',
        path: rel,
        mode: cfg.mode,
        result: 'ok',
        status: 200,
      });
      return { result: 'ok', error: null };
    });

    const res = await postRun(app, 'meeting-summary', { source: 'meetings/2026-07-16.md' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { kind: string; ok: boolean }[] };
    expect(body.results[0]).toMatchObject({ kind: 'agent-run', ok: true });

    const entries = await readAuditEntries(vaultRoot);
    const ops = entries.map((e) => e.op);
    // command 実行そのもの (ミドルウェア) と agent-run.step (ハンドラ直書き)
    expect(ops).toContain('command.run');
    expect(ops).toContain('agent-run.step');
    // agent 側書き込み (journal_append ツール委譲) の監査
    expect(ops).toContain('agent.journal_append');

    // agent の書き込み先が vault ルート内の当日ジャーナルであること
    const journalRel = journalPath(todayJournalDate(new Date()));
    const agentWrite = entries.find((e) => e.op === 'agent.journal_append');
    expect(agentWrite?.path).toBe(journalRel);
    expect(agentWrite?.path.startsWith('..')).toBe(false);
    expect(path.isAbsolute(agentWrite?.path ?? '')).toBe(false);

    // 実際にジャーナルへサマリーが書かれたこと
    const journal = await readFile(path.join(vaultRoot, journalRel), 'utf8');
    expect(journal).toContain('議事録');
    expect(journal).toContain('A を決定');
  });

  it('vault 外への書き込みは既存サービス層 (normalizeVaultPath / writeNote) が拒否する', async () => {
    // エージェントが prompt 指示を逸脱し vault 外へ書こうとしても、書き込みツールが
    // 使う normalizeVaultPath / writeNote が VaultPathError を投げて拒否する。
    // ここでは agent-run スタブ内で vault 外書き込みを試み、拒否されることを確認する。
    let rejected = false;
    runAgentJobMock.mockImplementation(async (cfg) => {
      try {
        await writeNote(cfg.vaultRoot, '../escape.md', 'leaked');
      } catch {
        rejected = true;
      }
      return { result: 'ok', error: null };
    });

    const res = await postRun(app, 'meeting-summary', { source: 'meetings/2026-07-16.md' });
    expect(res.status).toBe(200);
    expect(rejected).toBe(true);
    // vault 外にファイルが作られていないこと
    const escaped = await readFile(path.join(vaultRoot, '..', 'escape.md'), 'utf8').catch(() => null);
    expect(escaped).toBeNull();
  });
});
