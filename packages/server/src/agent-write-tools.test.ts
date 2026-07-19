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

/** details を { error?, created?, deleted?, path? } として narrow して読む。 */
function detailsOf(
  result: ExecResult,
): { error?: boolean; created?: boolean; deleted?: boolean; path?: string } {
  const d = result.details;
  if (typeof d === 'object' && d !== null) {
    return d as { error?: boolean; created?: boolean; deleted?: boolean; path?: string };
  }
  return {};
}

/** 全ケーパビリティ (write 系すべてを広告)。 */
const ALL_WRITE_CAPS: Capability[] = [
  'journal_append',
  'note_create',
  'note_edit',
  'note_delete',
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

  it('[AC-S5bd678-2-2] 全 write caps で 10 ツールが生成される (sorted 一致 / Se3b7a2-6)', () => {
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
    // note_property / note_move は note_edit 側で広告される (note_create 単独では出ない)
    expect(names).not.toContain('note_property');
    expect(names).not.toContain('note_move');
    expect(names).not.toContain('task_set_fields');
    // note_delete は独立ケーパビリティ
    expect(names).not.toContain('note_delete');
    expect(names).not.toContain('template_delete');
  });

  it('[agent-write-coverage] note_edit cap は note_edit + note_move + note_property + task_set_fields を広告する (Se3b7a2-6)', () => {
    const names = createVaultWriteTools(config, index, noDeny, ['note_edit'])
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['note_edit', 'note_move', 'note_property', 'task_set_fields']);
  });

  it('[agent-write-coverage] note_delete cap は note_delete のみを広告する (独立)', () => {
    const names = createVaultWriteTools(config, index, noDeny, ['note_delete']).map((t) => t.name);
    expect(names).toEqual(['note_delete']);
  });

  it('[agent-write-coverage] template_write cap は template_write + template_delete を広告する', () => {
    const names = createVaultWriteTools(config, index, noDeny, ['template_write'])
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['template_delete', 'template_write']);
  });

  it('[AC-S5bd678-2-2] read-only 相当 (write caps 空) では書き込みツールが 0 個', () => {
    const tools = createVaultWriteTools(config, index, noDeny, []);
    expect(tools).toHaveLength(0);
  });

  // ---- AC-S5bd678-2-1: journal_append -----------------------------------------

  it('[AC-S5bd678-2-1] journal_append が journals/YYYY/MM/YYYY-MM-DD.md を作成・追記する', async () => {
    const jt = tool('journal_append');
    const res = await jt.execute('t1', { text: '朝のメモ', date: '2026-07-12' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(res)).toContain('journals/2026/07/2026-07-12.md');

    const written = await readFile(path.join(vaultRoot, 'journals', '2026', '07', '2026-07-12.md'), 'utf8');
    expect(written).toBe('朝のメモ\n');

    // 二度目は追記される
    await jt.execute('t2', { text: '昼のメモ', date: '2026-07-12' }, noSignal, noUpdate, fakeCtx);
    const after = await readFile(path.join(vaultRoot, 'journals', '2026', '07', '2026-07-12.md'), 'utf8');
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

  // ---- agent-write-coverage: note_property ------------------------------------

  it('[agent-write-coverage] note_property が frontmatter を set/unset で編集する (round-trip)', async () => {
    await writeFile(
      path.join(vaultRoot, 'doc.md'),
      '---\ntitle: "Old"\nstatus: "draft"\n---\n\n本文\n',
      'utf8',
    );
    const pt = tool('note_property');
    const res = await pt.execute(
      't1',
      { path: 'doc', set: { title: 'New', tags: 'project' }, unset: ['status'] },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(res).error).toBeUndefined();
    const written = await readFile(path.join(vaultRoot, 'doc.md'), 'utf8');
    expect(written).toContain('title: New');
    expect(written).toContain('tags: project');
    expect(written).not.toContain('status:');
    // 本文は保持される
    expect(written).toContain('本文');
  });

  it('[agent-write-coverage] note_property は tags プロパティを追加・削除できる', async () => {
    await writeFile(path.join(vaultRoot, 'n.md'), '# タイトル\n', 'utf8');
    const pt = tool('note_property');
    await pt.execute('t1', { path: 'n', set: { tags: 'idea' } }, noSignal, noUpdate, fakeCtx);
    let written = await readFile(path.join(vaultRoot, 'n.md'), 'utf8');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toContain('tags: idea');
    // unset で削除
    await pt.execute('t2', { path: 'n', unset: ['tags'] }, noSignal, noUpdate, fakeCtx);
    written = await readFile(path.join(vaultRoot, 'n.md'), 'utf8');
    expect(written).not.toContain('tags:');
  });

  it('[agent-write-coverage] note_property は対象ノート不在でエラーを返す', async () => {
    const pt = tool('note_property');
    const res = await pt.execute('t1', { path: 'ghost', set: { a: 'b' } }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/見つかりません|not found/i);
  });

  it('[agent-write-coverage] note_property は安全に解析できない frontmatter を書き換えずエラーを返す', async () => {
    // 壊れた YAML frontmatter — parseNote が frontmatter を null にする (安全に解析不可)。
    const original = '---\ntitle: "unterminated\nstatus: draft\n---\n\n本文\n';
    await writeFile(path.join(vaultRoot, 'complex.md'), original, 'utf8');
    const pt = tool('note_property');
    const res = await pt.execute('t1', { path: 'complex', set: { z: '1' } }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    // ファイルは一切変更しない
    const still = await readFile(path.join(vaultRoot, 'complex.md'), 'utf8');
    expect(still).toBe(original);
  });

  it('[agent-write-coverage] privacy deny にマッチするパスへの note_property を拒否する', async () => {
    await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'private', 'd.md'), '---\na: "1"\n---\n', 'utf8');
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const pt = tool('note_property', ALL_WRITE_CAPS, denyPrivate);
    const res = await pt.execute('t1', { path: 'private/d', set: { a: '2' } }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    const still = await readFile(path.join(vaultRoot, 'private', 'd.md'), 'utf8');
    expect(still).toBe('---\na: "1"\n---\n'); // 非破壊
  });

  // ---- agent-write-coverage: note_delete --------------------------------------

  it('[agent-write-coverage] note_delete が既存ノートを削除する', async () => {
    await writeFile(path.join(vaultRoot, 'gone.md'), '# 消す\n', 'utf8');
    const dt = tool('note_delete');
    const res = await dt.execute('t1', { path: 'gone' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).deleted).toBe(true);
    await expect(readFile(path.join(vaultRoot, 'gone.md'), 'utf8')).rejects.toThrow();
  });

  it('[agent-write-coverage] note_delete は存在しない path をエラーにせず「削除対象なし」を返す', async () => {
    const dt = tool('note_delete');
    const res = await dt.execute('t1', { path: 'nope' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBeUndefined();
    expect(detailsOf(res).deleted).toBeUndefined();
    expect(textOf(res)).toMatch(/削除対象なし/);
  });

  it('[agent-write-coverage] privacy deny にマッチするパスへの note_delete を拒否する', async () => {
    await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'private', 'keep.md'), 'secret\n', 'utf8');
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const dt = tool('note_delete', ALL_WRITE_CAPS, denyPrivate);
    const res = await dt.execute('t1', { path: 'private/keep' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    // ファイルは残る
    const still = await readFile(path.join(vaultRoot, 'private', 'keep.md'), 'utf8');
    expect(still).toBe('secret\n');
  });

  it('[agent-write-coverage] note_delete が vault 脱出パス (../x) を拒否する', async () => {
    const dt = tool('note_delete');
    const res = await dt.execute('t1', { path: '../escape' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/パスエラー|traversal/i);
  });

  // ---- agent-write-coverage: note_move (リネーム/移動 + リンク追従) ------------

  it('[agent-write-coverage] note_move が移動 + [[リンク]]一括追従する', async () => {
    await writeFile(path.join(vaultRoot, 'old.md'), '# 旧\n', 'utf8');
    await writeFile(path.join(vaultRoot, 'ref.md'), 'see [[old]]\n', 'utf8');
    const mt = tool('note_move');
    const res = await mt.execute('t1', { from: 'old', to: 'new' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBeUndefined();
    expect(detailsOf(res).path).toBe('new.md');
    // ファイルが移動している
    await expect(readFile(path.join(vaultRoot, 'old.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(vaultRoot, 'new.md'), 'utf8')).toBe('# 旧\n');
    // 参照元のリンクが追従している
    expect(await readFile(path.join(vaultRoot, 'ref.md'), 'utf8')).toBe('see [[new]]\n');
    expect(textOf(res)).toMatch(/追従リンク 1/);
  });

  it('[agent-write-coverage] note_move は移動先が既存なら拒否する (上書きしない)', async () => {
    await writeFile(path.join(vaultRoot, 'a.md'), 'A\n', 'utf8');
    await writeFile(path.join(vaultRoot, 'b.md'), 'B\n', 'utf8');
    const mt = tool('note_move');
    const res = await mt.execute('t1', { from: 'a', to: 'b' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    // 両方とも無傷
    expect(await readFile(path.join(vaultRoot, 'a.md'), 'utf8')).toBe('A\n');
    expect(await readFile(path.join(vaultRoot, 'b.md'), 'utf8')).toBe('B\n');
  });

  it('[agent-write-coverage] note_move は from が存在しないとエラー', async () => {
    const mt = tool('note_move');
    const res = await mt.execute('t1', { from: 'nope', to: 'dst' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/見つかりません/);
  });

  it('[agent-write-coverage] note_move は from/to の deny を両方拒否する', async () => {
    await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'private', 's.md'), 'secret\n', 'utf8');
    await writeFile(path.join(vaultRoot, 'pub.md'), 'pub\n', 'utf8');
    const denyPrivate = (rel: string): boolean => rel.startsWith('private/');
    const mt = tool('note_move', ALL_WRITE_CAPS, denyPrivate);
    // from が deny
    const r1 = await mt.execute('t1', { from: 'private/s', to: 'moved' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(r1).error).toBe(true);
    // to が deny
    const r2 = await mt.execute('t2', { from: 'pub', to: 'private/x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(r2).error).toBe(true);
    // どちらもファイルは無傷
    expect(await readFile(path.join(vaultRoot, 'private', 's.md'), 'utf8')).toBe('secret\n');
    expect(await readFile(path.join(vaultRoot, 'pub.md'), 'utf8')).toBe('pub\n');
  });

  it('[agent-write-coverage] note_move の成功は audit.log に agent.note_move を記録する', async () => {
    await writeFile(path.join(vaultRoot, 'src.md'), '# s\n', 'utf8');
    await tool('note_move').execute('h', { from: 'src', to: 'dst' }, noSignal, noUpdate, fakeCtx);
    const ops = (await readAudit(vaultRoot)).map((e) => e.op);
    expect(ops).toContain('agent.note_move');
  });

  // ---- agent-write-coverage: template 上書き / template_delete -----------------

  it('[agent-write-coverage] template_write は overwrite:true で既存テンプレートを上書きする', async () => {
    await mkdir(path.join(vaultRoot, 'templates'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'templates', 'm.md'), 'OLD\n', 'utf8');
    const tw = tool('template_write');
    // overwrite なしは拒否 (既存)
    const denied = await tw.execute('t1', { name: 'm', body: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(denied).error).toBe(true);
    expect(await readFile(path.join(vaultRoot, 'templates', 'm.md'), 'utf8')).toBe('OLD\n');
    // overwrite:true は上書き成功 (created:false)
    const ok = await tw.execute(
      't2',
      { name: 'm', body: '# 新\n', overwrite: true },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    expect(detailsOf(ok).error).toBeUndefined();
    expect(detailsOf(ok).created).toBe(false);
    const written = await readFile(path.join(vaultRoot, 'templates', 'm.md'), 'utf8');
    expect(written).toContain('type: "template"');
    expect(written).toContain('# 新');
  });

  it('[agent-write-coverage] template_delete が既存テンプレートを削除する / 不在は削除対象なし', async () => {
    await mkdir(path.join(vaultRoot, 'templates'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'templates', 'x.md'), '---\ntype: "template"\n---\n', 'utf8');
    const td = tool('template_delete');
    const res = await td.execute('t1', { name: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(res).deleted).toBe(true);
    await expect(readFile(path.join(vaultRoot, 'templates', 'x.md'), 'utf8')).rejects.toThrow();
    // 不在は削除対象なし
    const none = await td.execute('t2', { name: 'x' }, noSignal, noUpdate, fakeCtx);
    expect(detailsOf(none).error).toBeUndefined();
    expect(textOf(none)).toMatch(/削除対象なし/);
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
    await tool('note_property').execute('f', { path: 'doc', set: { done: true } }, noSignal, noUpdate, fakeCtx);
    await tool('template_delete').execute('g', { name: 'tpl' }, noSignal, noUpdate, fakeCtx);
    await tool('note_delete').execute('h', { path: 'idx' }, noSignal, noUpdate, fakeCtx);

    const entries = await readAudit(vaultRoot);
    const ops = entries.map((e) => e.op);
    expect(ops).toContain('agent.journal_append');
    expect(ops).toContain('agent.note_create');
    expect(ops).toContain('agent.note_edit');
    expect(ops).toContain('agent.template_write');
    expect(ops).toContain('agent.dataview_write');
    expect(ops).toContain('agent.note_property');
    expect(ops).toContain('agent.template_delete');
    expect(ops).toContain('agent.note_delete');

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

  // ---- [Se3b7a2-6] task_set_fields -------------------------------------------

  it('[AC-Se3b7a2-6] task_set_fields がタスク行の status フィールドを設定する', async () => {
    await writeFile(
      path.join(vaultRoot, 'todos.md'),
      '- [ ] タスク A\n- [ ] タスク B\n',
      'utf8',
    );
    const t = tool('task_set_fields');
    const res = await t.execute(
      't1',
      { path: 'todos', line: 0, status: 'progress' },
      noSignal, noUpdate, fakeCtx,
    );
    expect(detailsOf(res).error).toBeUndefined();
    const written = await readFile(path.join(vaultRoot, 'todos.md'), 'utf8');
    expect(written).toContain('[status:: progress]');
    expect(written).toContain('- [ ] タスク B'); // 他行は変更なし
  });

  it('[AC-Se3b7a2-6] task_set_fields が priority / due フィールドも設定できる', async () => {
    await writeFile(
      path.join(vaultRoot, 'todos.md'),
      '- [ ] 優先タスク\n',
      'utf8',
    );
    const t = tool('task_set_fields');
    const res = await t.execute(
      't1',
      { path: 'todos', line: 0, priority: 'high', due: '2026-08-01' },
      noSignal, noUpdate, fakeCtx,
    );
    expect(detailsOf(res).error).toBeUndefined();
    const written = await readFile(path.join(vaultRoot, 'todos.md'), 'utf8');
    expect(written).toContain('[priority:: high]');
    expect(written).toContain('[due:: 2026-08-01]');
  });

  it('[AC-Se3b7a2-6] task_set_fields が null を渡すとフィールドを削除する', async () => {
    await writeFile(
      path.join(vaultRoot, 'todos.md'),
      '- [ ] タスク [status:: progress] [due:: 2026-08-01]\n',
      'utf8',
    );
    const t = tool('task_set_fields');
    const res = await t.execute(
      't1',
      { path: 'todos', line: 0, status: null, due: null },
      noSignal, noUpdate, fakeCtx,
    );
    expect(detailsOf(res).error).toBeUndefined();
    const written = await readFile(path.join(vaultRoot, 'todos.md'), 'utf8');
    expect(written).not.toContain('[status::');
    expect(written).not.toContain('[due::');
  });

  it('[AC-Se3b7a2-6] task_set_fields がタスク行でない行にはエラーを返す', async () => {
    await writeFile(
      path.join(vaultRoot, 'todos.md'),
      '# 見出し\n- [ ] タスク\n',
      'utf8',
    );
    const t = tool('task_set_fields');
    const res = await t.execute(
      't1',
      { path: 'todos', line: 0, status: 'done' },
      noSignal, noUpdate, fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/タスク行|not a task/i);
  });

  it('[AC-Se3b7a2-6] task_set_fields が範囲外の行番号にはエラーを返す', async () => {
    await writeFile(
      path.join(vaultRoot, 'todos.md'),
      '- [ ] タスク\n',
      'utf8',
    );
    const t = tool('task_set_fields');
    const res = await t.execute(
      't1',
      { path: 'todos', line: 99, status: 'done' },
      noSignal, noUpdate, fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/範囲外|out of range/i);
  });

  it('[AC-Se3b7a2-6] task_set_fields が存在しないノートにはエラーを返す', async () => {
    const t = tool('task_set_fields');
    const res = await t.execute(
      't1',
      { path: 'nonexistent', line: 0, status: 'done' },
      noSignal, noUpdate, fakeCtx,
    );
    expect(detailsOf(res).error).toBe(true);
    expect(textOf(res)).toMatch(/見つかりません|not found/i);
  });

  it('[AC-Se3b7a2-6] task_set_fields の成功は audit.log に op:agent.task_set_fields を記録する', async () => {
    await writeFile(
      path.join(vaultRoot, 'todos.md'),
      '- [ ] タスク\n',
      'utf8',
    );
    const t = tool('task_set_fields');
    await t.execute(
      't1',
      { path: 'todos', line: 0, status: 'progress' },
      noSignal, noUpdate, fakeCtx,
    );
    const entries = await readAudit(vaultRoot);
    expect(entries.some((e) => e.op === 'agent.task_set_fields')).toBe(true);
  });
});
