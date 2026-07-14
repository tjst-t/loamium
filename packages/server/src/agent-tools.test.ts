/**
 * エージェントツール境界テスト (S53409d-3)。
 *
 * AC-S53409d-3-1: ツールセットが read 系 5 種のみ (ADR-0012)。カスタム read ツールは read_note に改名。
 * AC-S53409d-3-4: read_note / backlinks ツールが vault 脱出パスを拒否する。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex } from './noteIndex.js';
import { createVaultReadTools, VAULT_READ_TOOL_NAMES } from './agent-tools.js';
import { AGENT_HELP_TOPICS, helpTopicNames } from './agent-help.js';

// ---- テスト用ヘルパー ----------------------------------------------------------

/** ダミーの AbortSignal を返す。 */
const noSignal = undefined;
/** ダミーの onUpdate を返す。 */
const noUpdate = undefined;

/**
 * テスト用ミニマル ExtensionContext。
 * ツール execute() の第 5 引数だが、vault 読み取りツールは使用しないため空オブジェクトで十分。
 */
const fakeCtx = {} as Parameters<ReturnType<typeof createVaultReadTools>[number]['execute']>[4];

// ---- テスト ------------------------------------------------------------------

describe('createVaultReadTools', () => {
  let vaultRoot: string;
  let index: VaultIndex;
  let tools: ReturnType<typeof createVaultReadTools>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-tools-test-'));
    index = new VaultIndex(vaultRoot);
    tools = createVaultReadTools(index, vaultRoot);
  });

  // ---- AC-S53409d-3-1: ツールセット固定 ----------------------------------------
  //
  // pi SDK の AgentSession.getActiveToolNames() で「セッションに登録されたツール名」を
  // イントロスペクトできるが、createAgentSession() は model/auth 等の外部依存が必要なため
  // ここでは unit として確認できない。代わりに:
  //   1. createVaultReadTools() が返すツール名を直接アサート (下記 2 テスト)
  //   2. LLM への実リクエストを実測するガードは e2e (agent-tools.e2e.spec.ts) が担う
  //      — AC-3-1: advertisedTools === ['backlinks','query','read_note','search','tags']
  //      — このアサートは削除・弱体化しないこと (ADR-0012 の回帰防止)。

  it('[AC-S53409d-3-1] 生成されるツール名は VAULT_READ_TOOL_NAMES と一致する (sorted)', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...VAULT_READ_TOOL_NAMES].sort());
    // カスタム read ツールは read_note に改名 (ADR-0012 collision 排除)。
    // help は ADR-0014 で追加された読み取り系ツール。
    expect(names).toEqual(['backlinks', 'help', 'query', 'read_note', 'search', 'tags']);
  });

  it('[AC-S53409d-3-1] ツール名に write/bash/shell/edit 等は含まれない', () => {
    const names = tools.map((t) => t.name);
    const forbidden = ['write', 'bash', 'edit', 'shell', 'find', 'grep', 'ls', 'journal-append'];
    for (const f of forbidden) {
      expect(names).not.toContain(f);
    }
  });

  // ---- AC-S53409d-3-4: パス脱出拒否 -------------------------------------------

  it('[AC-S53409d-3-4] read_note ツールが "../../../etc/passwd" を拒否しエラーテキストを返す', async () => {
    const readTool = tools.find((t) => t.name === 'read_note');
    expect(readTool).toBeDefined();
    if (!readTool) return;

    const result = await readTool.execute('tc-1', { path: '../../../etc/passwd' }, noSignal, noUpdate, fakeCtx);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/パスエラー|traversal/i);
  });

  it('[AC-S53409d-3-4] backlinks ツールが vault 脱出パスを拒否しエラーテキストを返す', async () => {
    const backlinksTool = tools.find((t) => t.name === 'backlinks');
    expect(backlinksTool).toBeDefined();
    if (!backlinksTool) return;

    const result = await backlinksTool.execute(
      'tc-2',
      { path: '../../etc/shadow' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    const text = (result.content[0] as { type: 'text'; text: string } | undefined)?.text ?? '';
    expect(text).toMatch(/パスエラー|traversal/i);
  });

  it('[AC-S53409d-3-4] read_note ツールが隠しパス ".loamium/agent.json" を拒否する', async () => {
    const readTool = tools.find((t) => t.name === 'read_note');
    expect(readTool).toBeDefined();
    if (!readTool) return;

    const result = await readTool.execute('tc-3', { path: '.loamium/agent.json' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string } | undefined)?.text ?? '';
    // hidden segment (.loamium) は VaultPathError で拒否される
    expect(text).toMatch(/パスエラー|hidden|traversal/i);
  });

  // ---- AC-Sa10026-6-1: 設定書込 API の agent ツール除外 (自己昇格防止) ----------

  it('[AC-Sa10026-6-1] read_note ツールが ".loamium/agent-privacy.json" (deny-list) を拒否する', async () => {
    // agent が deny-list 自体を読み取って自己の動作を調査できないことを確認。
    const readTool = tools.find((t) => t.name === 'read_note');
    expect(readTool).toBeDefined();
    if (!readTool) return;

    const result = await readTool.execute(
      'tc-sa10026-6-1',
      { path: '.loamium/agent-privacy.json' },
      noSignal,
      noUpdate,
      fakeCtx,
    );
    const text = (result.content[0] as { type: 'text'; text: string } | undefined)?.text ?? '';
    expect(text).toMatch(/パスエラー|hidden|traversal/i);
  });

  it('[AC-Sa10026-6-1] VAULT_READ_TOOL_NAMES に settings 書込系ツール名が含まれない (advertised-toolset pin)', () => {
    // VAULT_READ_TOOL_NAMES は agent-tools.e2e.spec.ts の '[AC-S53409d-3-1]' でも
    // 実 LLM リクエストの tools フィールドを実測して固定される (ADR-0012 回帰防止)。
    // 設定書込系ツール名が含まれないことを unit でも確認する。
    const settingsToolPatterns = [
      'settings',
      'agent_config',
      'agent_permission',
      'agent_privacy',
      'agent_connection',
    ];
    for (const pattern of settingsToolPatterns) {
      for (const toolName of VAULT_READ_TOOL_NAMES) {
        expect(toolName).not.toContain(pattern);
      }
    }
  });

  // ---- 正常系テスト -----------------------------------------------------------

  it('search ツールが vault 内のノートを検索できる', async () => {
    // ノートをファイルシステムに作成してインデックスを更新
    const noteContent = '# 設計メモ\n\nアーキテクチャの設計について。\n';
    await writeFile(path.join(vaultRoot, 'design.md'), noteContent, 'utf8');
    await index.refreshFile('design.md');

    const searchTool = tools.find((t) => t.name === 'search');
    expect(searchTool).toBeDefined();
    if (!searchTool) return;

    const result = await searchTool.execute('tc-s1', { query: '設計' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('design');
  });

  it('tags ツールが vault のタグ一覧を返す', async () => {
    await writeFile(path.join(vaultRoot, 'tagged.md'), '# tagged\n\n#設計 #アーキテクチャ\n', 'utf8');
    await index.refreshFile('tagged.md');

    const tagsTool = tools.find((t) => t.name === 'tags');
    expect(tagsTool).toBeDefined();
    if (!tagsTool) return;

    const result = await tagsTool.execute('tc-t1', {}, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/設計|アーキテクチャ/);
  });

  it('read_note ツールが存在するノートのコンテンツを返す', async () => {
    const content = '# テストノート\n\n本文テスト。\n';
    await writeFile(path.join(vaultRoot, 'test-note.md'), content, 'utf8');

    const readTool = tools.find((t) => t.name === 'read_note');
    expect(readTool).toBeDefined();
    if (!readTool) return;

    const result = await readTool.execute('tc-r1', { path: 'test-note.md' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('本文テスト');
  });

  it('read_note ツールが存在しないノートに対してエラーテキストを返す', async () => {
    const readTool = tools.find((t) => t.name === 'read_note');
    expect(readTool).toBeDefined();
    if (!readTool) return;

    const result = await readTool.execute('tc-r2', { path: 'nonexistent.md' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/見つかりません|not found/i);
  });

  it('backlinks ツールが指定ノートへのバックリンクを返す', async () => {
    await mkdir(path.join(vaultRoot, 'subdir'), { recursive: true });
    await writeFile(path.join(vaultRoot, 'target.md'), '# ターゲット\n', 'utf8');
    await writeFile(path.join(vaultRoot, 'source.md'), '# ソース\n\n[[target]] を参照。\n', 'utf8');
    await index.build();

    const backlinksTool = tools.find((t) => t.name === 'backlinks');
    expect(backlinksTool).toBeDefined();
    if (!backlinksTool) return;

    const result = await backlinksTool.execute('tc-b1', { path: 'target.md' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('source');
  });

  it('query ツールが DQL クエリを実行できる', async () => {
    await writeFile(path.join(vaultRoot, 'note1.md'), '# Note 1\n\n#design\n', 'utf8');
    await index.build();

    const queryTool = tools.find((t) => t.name === 'query');
    expect(queryTool).toBeDefined();
    if (!queryTool) return;

    const result = await queryTool.execute('tc-q1', { dql: 'LIST' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('note1');
  });

  it('query ツールが DQL 構文エラーをスローせずエラーテキストで返す', async () => {
    const queryTool = tools.find((t) => t.name === 'query');
    expect(queryTool).toBeDefined();
    if (!queryTool) return;

    const result = await queryTool.execute('tc-q2', { dql: 'INVALID QUERY' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/構文エラー|error/i);
  });

  // ---- AC-S10a31c-2: help ツール ---------------------------------------------

  it('[AC-S10a31c-2-2] help は read allowlist (VAULT_READ_TOOL_NAMES) に含まれる', () => {
    expect(VAULT_READ_TOOL_NAMES).toContain('help');
    const helpTool = tools.find((t) => t.name === 'help');
    expect(helpTool).toBeDefined();
  });

  it('[AC-S10a31c-2-1] help がトピック指定でガイド本文を返す (dql)', async () => {
    const helpTool = tools.find((t) => t.name === 'help');
    expect(helpTool).toBeDefined();
    if (!helpTool) return;

    const result = await helpTool.execute('tc-h1', { topic: 'dql' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe(AGENT_HELP_TOPICS['dql']);
    expect(text).toMatch(/DQL/);
  });

  it('[AC-S10a31c-2-1] help がトピック名の大文字小文字・前後空白を無視して解決する', async () => {
    const helpTool = tools.find((t) => t.name === 'help');
    if (!helpTool) return;

    const result = await helpTool.execute('tc-h2', { topic: '  Wikilink  ' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe(AGENT_HELP_TOPICS['wikilink']);
  });

  it('[AC-S10a31c-2-1] help がトピック未指定のとき利用可能トピック一覧を返す (エラーにしない)', async () => {
    const helpTool = tools.find((t) => t.name === 'help');
    if (!helpTool) return;

    const result = await helpTool.execute('tc-h3', {}, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    // details.error は立てない (通常の成功結果)
    expect(result.details.error).toBeUndefined();
    for (const name of helpTopicNames()) {
      expect(text).toContain(name);
    }
  });

  it('[AC-S10a31c-2-1] help が未知トピックのとき利用可能トピック一覧を返す (エラーにしない)', async () => {
    const helpTool = tools.find((t) => t.name === 'help');
    if (!helpTool) return;

    const result = await helpTool.execute('tc-h4', { topic: 'no-such-topic' }, noSignal, noUpdate, fakeCtx);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(result.details.error).toBeUndefined();
    for (const name of helpTopicNames()) {
      expect(text).toContain(name);
    }
  });
});
