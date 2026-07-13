/**
 * エージェント機密領域 deny リスト強制テスト (ADR-0018 / Sf4ee2f)。
 *
 * [AC-Sf4ee2f-1-1]: deny マッチのファイルは read_note / backlinks(ターゲット指定) で読めず、
 *   未発見として扱われる (存在も内容も知らせない)。
 * [AC-Sf4ee2f-1-2]: search / query / tags / backlinks(参照元) がエージェントに返す結果から
 *   deny マッチのノートが除外される。deny > allow。
 * さらに loadAgentPrivacy の 不在→空 / 壊れ JSON→deny-all を検証する。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex } from './noteIndex.js';
import { createVaultReadTools } from './agent-tools.js';
import { loadAgentPrivacy } from './agent-privacy.js';

const noSignal = undefined;
const noUpdate = undefined;
const fakeCtx = {} as Parameters<ReturnType<typeof createVaultReadTools>[number]['execute']>[4];

/** ツール結果からテキストを取り出す。 */
function textOf(result: { content: readonly unknown[] }): string {
  const first = result.content[0];
  if (typeof first === 'object' && first !== null && 'text' in first) {
    const t = (first as { text: unknown }).text;
    return typeof t === 'string' ? t : '';
  }
  return '';
}

// deny リスト ["private/**"] を強制するツールセットを組み立てる共通フィクスチャ。
// - public/open.md: 非 deny。固有語 "公開情報オープン"、#公開タグ、[[private/secret]] を参照。
// - private/secret.md: deny 対象。固有語 "極秘サラリー"、固有 #機密タグ、[[public/open]] を参照。
async function buildFixture(): Promise<{
  vaultRoot: string;
  index: VaultIndex;
  tools: ReturnType<typeof createVaultReadTools>;
}> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-privacy-test-'));
  await mkdir(path.join(vaultRoot, 'private'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'public'), { recursive: true });

  await writeFile(
    path.join(vaultRoot, 'public', 'open.md'),
    '# 公開ノート\n\n公開情報オープンについて。 #公開\n\n[[private/secret]] を参照。\n',
    'utf8',
  );
  await writeFile(
    path.join(vaultRoot, 'private', 'secret.md'),
    '# 機密ノート\n\n極秘サラリーの情報。 #機密\n\n[[public/open]] を参照。\n',
    'utf8',
  );

  const index = new VaultIndex(vaultRoot);
  await index.build();

  const isDenied = (await loadAgentPrivacyFromPatterns(['private/**'])).isDenied;
  const tools = createVaultReadTools(index, vaultRoot, isDenied);
  return { vaultRoot, index, tools };
}

// deny パターンから isDenied を得るヘルパ (loadAgentPrivacy と同経路: shared のマッチャ)。
// ファイル I/O を経由せずパターンを直接コンパイルするため、shared 経由で構築する。
async function loadAgentPrivacyFromPatterns(patterns: string[]) {
  const { compilePrivacyMatcher } = await import('@loamium/shared');
  return { isDenied: compilePrivacyMatcher(patterns) };
}

function tool(tools: ReturnType<typeof createVaultReadTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('ADR-0018 deny リスト強制', () => {
  let vaultRoot: string;
  let index: VaultIndex;
  let tools: ReturnType<typeof createVaultReadTools>;

  beforeEach(async () => {
    ({ vaultRoot, index, tools } = await buildFixture());
  });

  it('[AC-Sf4ee2f-1-1] read_note は deny ノートを「見つかりません」で返す (存在を隠す)', async () => {
    const readTool = tool(tools, 'read_note');
    const denied = await readTool.execute('t1', { path: 'private/secret.md' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(denied);
    expect(text).toMatch(/見つかりません/);
    // 内容 (極秘サラリー) は漏れない
    expect(text).not.toContain('極秘サラリー');

    // 非 deny ノートは通常どおり読める (deny が過剰適用でないこと)
    const ok = await readTool.execute('t2', { path: 'public/open.md' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(ok)).toContain('公開情報オープン');
  });

  it('[AC-Sf4ee2f-1-1] read_note は拡張子なし指定でも deny を隠す (NFC/正規化後にマッチ)', async () => {
    const readTool = tool(tools, 'read_note');
    const denied = await readTool.execute('t3', { path: 'private/secret' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(denied)).toMatch(/見つかりません/);
    expect(textOf(denied)).not.toContain('極秘サラリー');
  });

  it('[AC-Sf4ee2f-1-1] backlinks は deny ターゲット指定で空を返す (存在を隠す)', async () => {
    const backlinksTool = tool(tools, 'backlinks');
    // private/secret への参照元 (public/open) は実在するが、ターゲットが deny なので空扱い
    const denied = await backlinksTool.execute('t4', { path: 'private/secret.md' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(denied);
    expect(text).toMatch(/バックリンクはありません/);
    expect(text).not.toContain('public/open');
  });

  it('[AC-Sf4ee2f-1-2] backlinks は deny 参照元を結果から除外する', async () => {
    const backlinksTool = tool(tools, 'backlinks');
    // public/open への参照元は private/secret のみ → deny 除外で 0 件になる
    const result = await backlinksTool.execute('t5', { path: 'public/open.md' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(result);
    expect(text).not.toContain('private/secret');
    expect(text).toMatch(/バックリンクはありません/);
  });

  it('[AC-Sf4ee2f-1-2] search は deny ノートの固有語でヒットしない', async () => {
    const searchTool = tool(tools, 'search');
    const result = await searchTool.execute('t6', { query: '極秘サラリー' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(result);
    // deny ノートの存在 (パス) がヒット結果として漏れないこと。
    // ("極秘サラリー" 自体は入力クエリのエコーとして「一致なし」文言に含まれるが、
    //  それはユーザー入力の反復であり deny ノートの内容漏洩ではない。件数 0 / パス非出現で判定する。)
    expect(text).not.toContain('private/secret');
    expect(result.details.count).toBe(0);

    // 非 deny の固有語は従来どおりヒットする
    const ok = await searchTool.execute('t7', { query: '公開情報オープン' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(ok)).toContain('public/open');
  });

  it('[AC-Sf4ee2f-1-2] query(LIST) 結果に deny ノートが出ない', async () => {
    const queryTool = tool(tools, 'query');
    const result = await queryTool.execute('t8', { dql: 'LIST' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(result);
    expect(text).toContain('public/open');
    expect(text).not.toContain('private/secret');
  });

  it('[AC-Sf4ee2f-1-2] query(FROM #機密) は deny 限定タグでも deny ノートを返さない', async () => {
    const queryTool = tool(tools, 'query');
    const result = await queryTool.execute('t9', { dql: 'LIST FROM #機密' }, noSignal, noUpdate, fakeCtx);
    const text = textOf(result);
    expect(text).not.toContain('private/secret');
  });

  it('[AC-Sf4ee2f-1-2] tags に deny ノート限定タグ (#機密) が出ない', async () => {
    const tagsTool = tool(tools, 'tags');
    const result = await tagsTool.execute('t10', {}, noSignal, noUpdate, fakeCtx);
    const text = textOf(result);
    // 非 deny タグは出る
    expect(text).toContain('公開');
    // deny 限定タグは漏れない
    expect(text).not.toContain('機密');
  });

  it('deny を渡さないと (既定 no-deny) すべて見える — 過剰適用でないことの対照', async () => {
    // 同じ index を deny なしで生成すると deny ノートが見える (フィルタの効果を反証)
    const openTools = createVaultReadTools(index, vaultRoot);
    const searchTool = tool(openTools, 'search');
    const result = await searchTool.execute('t11', { query: '極秘サラリー' }, noSignal, noUpdate, fakeCtx);
    expect(textOf(result)).toContain('private/secret');
  });
});

describe('loadAgentPrivacy ファイル読込', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-privacy-load-test-'));
    await mkdir(path.join(vaultRoot, '.loamium'), { recursive: true });
  });

  it('ファイル不在 → 空 deny (常に false)', async () => {
    const { isDenied } = await loadAgentPrivacy(vaultRoot);
    expect(isDenied('private/secret.md')).toBe(false);
    expect(isDenied('anything.md')).toBe(false);
  });

  it('{ deny: [...] } 形式を読み込む', async () => {
    await writeFile(
      path.join(vaultRoot, '.loamium', 'agent-privacy.json'),
      JSON.stringify({ deny: ['private/**'] }),
      'utf8',
    );
    const { isDenied } = await loadAgentPrivacy(vaultRoot);
    expect(isDenied('private/secret.md')).toBe(true);
    expect(isDenied('public/open.md')).toBe(false);
  });

  it('直接 string 配列形式を読み込む', async () => {
    await writeFile(
      path.join(vaultRoot, '.loamium', 'agent-privacy.json'),
      JSON.stringify(['secret.md']),
      'utf8',
    );
    const { isDenied } = await loadAgentPrivacy(vaultRoot);
    expect(isDenied('secret.md')).toBe(true);
    expect(isDenied('other.md')).toBe(false);
  });

  it('壊れた JSON → 安全側 deny-all (常に true)', async () => {
    await writeFile(
      path.join(vaultRoot, '.loamium', 'agent-privacy.json'),
      '{ this is not valid json',
      'utf8',
    );
    const { isDenied } = await loadAgentPrivacy(vaultRoot);
    expect(isDenied('anything.md')).toBe(true);
    expect(isDenied('public/readme.md')).toBe(true);
  });

  it('スキーマ検証失敗 (deny が数値) → 安全側 deny-all', async () => {
    await writeFile(
      path.join(vaultRoot, '.loamium', 'agent-privacy.json'),
      JSON.stringify({ deny: 123 }),
      'utf8',
    );
    const { isDenied } = await loadAgentPrivacy(vaultRoot);
    expect(isDenied('anything.md')).toBe(true);
  });
});
