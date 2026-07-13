/**
 * エージェント書き込みツールのユニットテスト (S5bd678-2 / ADR-0016)。
 *
 * [AC-S5bd678-2-1] 5 書き込みツールが REST と同一の note-service を経由して書き込み、
 *   ピュア Markdown・normalizeVaultPath を継承する。note_create は既存パスで作成しない、
 *   note_edit は非破壊 old→new patch、template_write は templates/ の frontmatter ノート、
 *   dataview_write は ```dataview フェンス挿入。
 * [AC-S5bd678-2-2] caps に含まれる書き込みツールだけが生成 (広告) される。
 *   全書き込みが audit.log に記録される (ツール名・パス)。
 * [AC-S5bd678-2-3] privacy deny / vault 脱出 / 隠しセグメント (.loamium) への書き込みを拒否。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex } from './noteIndex.js';
import { createVaultWriteTools, VAULT_WRITE_TOOL_NAMES } from './agent-write-tools.js';
import type { ServerConfig } from './config.js';
import type { Capability } from '@loamium/shared';

// ---- ヘルパー ------------------------------------------------------------------

const noSignal = undefined;
const noUpdate = undefined;
const fakeCtx = {} as Parameters<
  ReturnType<typeof createVaultWriteTools>[number]['execute']
>[4];

type ExecResult = Awaited<ReturnType<ReturnType<typeof createVaultWriteTools>[number]['execute']>>;

/** ツール実行結果からテキストを取り出す (最初の text コンテンツ)。 */
function textOf(result: ExecResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}

/** details を { error?, created?, path? } として narrow して読む。 */
function detailsOf(result: ExecResult): { error?: boolean; created?: boolean; path?: string } {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; created?: boolean; path?: string };
  }
  return {};
}

/** 全ケーパビリティ (write 系すべてを広告)。 */
const ALL_WRITE_CAPS: Capability[] = [
  'journal_append',
  'note_create',
  'note_edit',
  'template_write',
  'dataview_write',
];

function makeConfig(vaultRoot: string): ServerConfig {
  return { vaultRoot, mode: 'full', maxUploadBytes: 1024 };
}

/** audit.log を JSONL としてパースし配列で返す (無ければ空)。 */
async function readAudit(vaultRoot: string): Promise<{ op: string; path: string; result: string }[]> {
  try {
    const raw = await readFile(path.join(vaultRoot, '.loamium', 'audit.log'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op: string; path: string; result: string });
  } catch {
    return [];
  }
}

// ---- テスト --------------------------------------------------------------------

describe('createVaultWriteTools', () => {
  let vaultRoot: string;
  let index: VaultIndex;
  let config: ServerConfig;
  const noDeny = (_rel: string): boolean => false;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-write-test-'));
    index = new VaultIndex(vaultRoot);
    config = makeConfig(vaultRoot);
  });

  function tool(name: string, caps: Capability[] = ALL_WRITE_CAPS, isDenied = noDeny) {
    const tools = createVaultWriteTools(config, index, isDenied, caps);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not generated: ${name}`);
    return t;
  }

  // ---- AC-S5bd678-2-2: 広告制御 ------------------------------------------------

  it('[AC-S5bd678-2-2] 全 write caps で 5 ツールが生成される (sorted 一致)', () => {
    const names = createVaultWriteTools(config, index, noDeny, ALL_WRITE_CAPS)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...VAULT_WRITE_TOOL_NAMES].sort());
  });

  it('[AC-S5bd678-2-2] caps に含まれない書き込みツールは生成されない (広告されない)', () => {
    const names = createVaultWriteTools(config, index, noDeny, ['note_create']).map((t) => t.name);
    expect(names).toEqual(['note_create']);
    expect(names).not.toContain('note_edit');
    expect(names).not.toContain('journal_append');
    expect(names).not.toContain('template_write');
    expect(names).not.toContain('dataview_write');
  });

  it('[AC-S5bd678-2-2] read-only 相当 (write caps 空) では書き込みツールが 0 個', () => {
    const tools = createVaultWriteTools(config, index, noDeny, []);
    expect(tools).toHaveLength(0);
  });

  // ---- AC-S5bd678-2-1: journal_append -----------------------------------------

  it('[AC-S5bd678-2-1] journal_append が journals/YYYY-MM-DD.md を作成・追記する', async () => {
    const jt = tool('journal_append');
    const res = await jt.execute('t1', { text: '朝のメモ', date: '2026-07-12' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(res)).toContain('journals/2026-07-12.md');

    const written = await readFile(path.join(vaultRoot, 'journals', '2026-07-12.md'), 'utf8');
    expect(written).toBe('朝のメモ\n');

    // 二度目は追記される
    await jt.execute('t2', { text: '昼のメモ', date: '2026-07-12' }, noSignal, noUpdate, fakeCtx);
    const after = await readFile(path.join(vaultRoot, 'journals', '2026-07-12.md'), 'utf8');
    expect(after).toBe('朝のメモ\n昼のメモ\n');
  });

  it('[AC-S5bd678-2-1] journal_append は不正な日付をエラーテキストで返す', async () => {
    const jt = tool('journal_append');
    const res = await jt.execute('t1', { text: 'x', date: '2026-13-99' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(res)).toMatch(/日付|invalid/i);
    expect(detailsOf(res).error).toBe(true);
  });

  // ---- AC-S5bd678-2-1: note_create --------------------------------------------

  it('[AC-S5bd678-2-1] note_create が新規ノートをピュア Markdown で作成する', async () => {
    const ct = tool('note_create');
    const res = await ct.execute('t1', { path: 'project/idea', content: '# アイデア\n\n本文\n' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).created).toBe(true);
    const written = await readFile(path.join(vaultRoot, 'project', 'idea.md'), 'utf8');
    expect(written).toBe('# アイデア\n\n本文\n');
  });

  it('[AC-S5bd678-2-1] note_create は既存パスでは作成せず 409 相当のテキストを返す', async () => {
    await mkdir(path.join(vaultRoot, 'project'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'project', 'idea.md'), 'ORIGINAL\n', 'utf8');

    const ct = tool('note_create');
    const res = await ct.execute('t1', { path: 'project/idea', content: 'NEW' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/既に存在|already/i);
    // ファイルは上書きされない (非破壊)
    const still = await readFile(path.join(vaultRoot, 'project', 'idea.md'), 'utf8');
    expect(still).toBe('ORIGINAL\n');
  });

  // ---- AC-S5bd678-2-1: note_edit ----------------------------------------------

  it('[AC-S5bd678-2-1] note_edit が old→new を非破壊 patch する', async () => {
    await writeFile(path.join(vaultRoot, 'doc.md'), 'hello world\ntail\n', 'utf8');
    const et = tool('note_edit');
    const res = await et.execute('t1', { path: 'doc', old: 'world', new: 'loamium' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBeUndefined();
    const written = await readFile(path.join(vaultRoot, 'doc.md'), 'utf8');
    expect(written).toBe('hello loamium\ntail\n');
  });

  it('[AC-S5bd678-2-1] note_edit は old 不在でエラーを返しファイルを変更しない', async () => {
    await writeFile(path.join(vaultRoot, 'doc.md'), 'hello world\n', 'utf8');
    const et = tool('note_edit');
    const res = await et.execute('t1', { path: 'doc', old: 'MISSING', new: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    const written = await readFile(path.join(vaultRoot, 'doc.md'), 'utf8');
    expect(written).toBe('hello world\n');
  });

  it('[AC-S5bd678-2-1] note_edit は old 複数箇所一致 (曖昧) でエラーを返す', async () => {
    await writeFile(path.join(vaultRoot, 'doc.md'), 'a\na\n', 'utf8');
    const et = tool('note_edit');
    const res = await et.execute('t1', { path: 'doc', old: 'a', new: 'b' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/locations|曖昧|matches/i);
  });

  // ---- AC-S5bd678-2-1: template_write -----------------------------------------

  it('[AC-S5bd678-2-1] template_write が templates/ に frontmatter 付きノートを作成する', async () => {
    const tw = tool('template_write');
    const res = await tw.execute(
      't1',
      { name: 'meeting', body: '# 議事録\n\n- 出席者:\n', frontmatter: { tags: 'meeting' } },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).created).toBe(true);
    const written = await readFile(path.join(vaultRoot, 'templates', 'meeting.md'), 'utf8');
    // 標準の Markdown YAML frontmatter で始まる
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toContain('type: "template"');
    expect(written).toContain('tags: "meeting"');
    expect(written).toContain('# 議事録');
  });

  it('[AC-S5bd678-2-1] template_write の出力にブロック ID・独自記法が含まれない (ピュア Markdown)', async () => {
    const tw = tool('template_write');
    await tw.execute('t1', { name: 'plain', body: 'body text\n' }, noSignal, noUpdate, fakeCtx);
    const written = await readFile(path.join(vaultRoot, 'templates', 'plain.md'), 'utf8');
    // ブロック ID (^abc123) / 独自 %%記法%% / <!-- loamium: --> 等が無いこと
    expect(written).not.toMatch(/\^[a-zA-Z0-9]{4,}/); // Obsidian ブロック ID
    expect(written).not.toContain('%%');
    expect(written).not.toMatch(/loamium:/i);
    // frontmatter は標準の --- 区切りのみ (2 本の --- 行)
    const fences = written.split('\n').filter((l) => l === '---');
    expect(fences).toHaveLength(2);
  });

  // ---- AC-S5bd678-2-1: dataview_write -----------------------------------------

  it('[AC-S5bd678-2-1] dataview_write が既存ノートに ```dataview フェンスを挿入する', async () => {
    await writeFile(path.join(vaultRoot, 'index.md'), '# 索引\n', 'utf8');
    const dw = tool('dataview_write');
    const res = await dw.execute('t1', { path: 'index', query: 'LIST FROM #project' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBeUndefined();
    const written = await readFile(path.join(vaultRoot, 'index.md'), 'utf8');
    expect(written).toContain('```dataview\nLIST FROM #project\n```');
    // 元の本文は保持される (非破壊 append)
    expect(written.startsWith('# 索引\n')).toBe(true);
  });

  it('[AC-S5bd678-2-1] dataview_write は対象ノート不在でエラーを返す', async () => {
    const dw = tool('dataview_write');
    const res = await dw.execute('t1', { path: 'ghost', query: 'LIST' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
  });

  // ---- AC-S5bd678-2-3: パス安全 / privacy deny --------------------------------

  it('[AC-S5bd678-2-3] note_create が vault 脱出パス (../x) を拒否する', async () => {
    const ct = tool('note_create');
    const res = await ct.execute('t1', { path: '../escape', content: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/パスエラー|traversal/i);
  });

  it('[AC-S5bd678-2-3] note_create が隠しセグメント (.loamium/) を拒否する', async () => {
    const ct = tool('note_create');
    const res = await ct.execute('t1', { path: '.loamium/secret', content: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/パスエラー|hidden/i);
  });

  it('[AC-S5bd678-2-3] privacy deny にマッチするパスへの note_create を拒否する (deny > allow)', async () => {
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const ct = tool('note_create', ALL_WRITE_CAPS, denyPrivate);
    const res = await ct.execute('t1', { path: 'private/diary', content: 'secret' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    // ファイルは書かれない
    await expect(readFile(path.join(vaultRoot, 'private', 'diary.md'), 'utf8')).rejects.toThrow();
  });

  it('[AC-S5bd678-2-3] privacy deny にマッチするパスへの note_edit を拒否する', async () => {
    await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'private', 'diary.md'), 'hello\n', 'utf8');
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const et = tool('note_edit', ALL_WRITE_CAPS, denyPrivate);
    const res = await et.execute('t1', { path: 'private/diary', old: 'hello', new: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    const still = await readFile(path.join(vaultRoot, 'private', 'diary.md'), 'utf8');
    expect(still).toBe('hello\n'); // 非破壊
  });

  // ---- AC-S5bd678-2-2: audit ログ ---------------------------------------------

  it('[AC-S5bd678-2-2] 全書き込みツールが audit.log にツール名 (op) とパスを記録する', async () => {
    await writeFile(path.join(vaultRoot, 'doc.md'), 'hello\n', 'utf8');
    await writeFile(path.join(vaultRoot, 'idx.md'), '# idx\n', 'utf8');

    await tool('journal_append').execute('a', { text: 'j', date: '2026-07-12' }, noSignal, noUpdate, fakeCtx);
    await tool('note_create').execute('b', { path: 'fresh', content: 'x' }, noSignal, noUpdate, fakeCtx);
    await tool('note_edit').execute('c', { path: 'doc', old: 'hello', new: 'hi' }, noSignal, noUpdate, fakeCtx);
    await tool('template_write').execute('d', { name: 'tpl', body: 'b' }, noSignal, noUpdate, fakeCtx);
    await tool('dataview_write').execute('e', { path: 'idx', query: 'LIST' }, noSignal, noUpdate, fakeCtx);

    const entries = await readAudit(vaultRoot);
    const ops = entries.map((e) => e.op);
    expect(ops).toContain('agent.journal_append');
    expect(ops).toContain('agent.note_create');
    expect(ops).toContain('agent.note_edit');
    expect(ops).toContain('agent.template_write');
    expect(ops).toContain('agent.dataview_write');

    // パスも記録されている
    const createEntry = entries.find((e) => e.op === 'agent.note_create');
    expect(createEntry?.path).toBe('fresh.md');
    const tplEntry = entries.find((e) => e.op === 'agent.template_write');
    expect(tplEntry?.path).toBe('templates/tpl.md');
    // 全て result: ok
    expect(entries.every((e) => e.result === 'ok')).toBe(true);
  });

  it('[AC-S5bd678-2-2] 拒否された書き込みは audit.log に記録しない (成功時のみ)', async () => {
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    await tool('note_create', ALL_WRITE_CAPS, denyPrivate).execute(
      't1',
      { path: 'private/x', content: 'x' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    const entries = await readAudit(vaultRoot);
    expect(entries).toHaveLength(0);
  });
});
