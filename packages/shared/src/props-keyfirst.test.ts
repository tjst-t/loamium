/**
 * Sd13ab1-2 キーファースト追加の純関数 (buildKeyOptions / filterKeyOptions /
 * canCreateNewKey) と Sd13ab1-1 値要約 (summaryEntriesFor) のユニットテスト。
 * 型解決は D方式 (resolvePropertyType) と一貫することを確認する。
 */
import { describe, expect, it } from 'vitest';
import {
  buildKeyOptions,
  canCreateNewKey,
  filterKeyOptions,
  WELL_KNOWN_KEYS,
  type KeyOption,
  type PropertyKeyCount,
} from './property-types.js';
import { summaryEntriesFor, type PropEntry } from './frontmatter.js';

const findKey = (opts: KeyOption[], key: string): KeyOption | undefined =>
  opts.find((o) => o.key === key);

describe('buildKeyOptions (キーファースト zone ① 候補)', () => {
  it('内蔵 well-known + JSON定義 + vault 実使用キーを重複排除して 1 覧にする', () => {
    const defs = { 優先度: { type: 'select' as const, options: [{ value: '高' }] } };
    const vaultKeys: PropertyKeyCount[] = [
      { key: 'hoge', count: 3 },
      { key: 'tags', count: 10 },
      { key: '優先度', count: 2 },
    ];
    const opts = buildKeyOptions(defs, vaultKeys, new Set());

    // 内蔵 well-known は全て含まれる
    for (const w of WELL_KNOWN_KEYS) expect(findKey(opts, w.key)).toBeDefined();
    // JSON定義キーは source=json
    expect(findKey(opts, '優先度')?.source).toBe('json');
    // vault のみのキー hoge は source=vault + 件数
    const hoge = findKey(opts, 'hoge');
    expect(hoge?.source).toBe('vault');
    expect(hoge?.count).toBe(3);
    // tags は well-known(builtin) だが vault 件数も補われる (重複しない)
    const tags = opts.filter((o) => o.key === 'tags');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.count).toBe(10);
  });

  it('この文書に既にあるキーは existing=true (重複不可)', () => {
    const opts = buildKeyOptions({}, [], new Set(['tags']));
    expect(findKey(opts, 'tags')?.existing).toBe(true);
    expect(findKey(opts, 'status')?.existing).toBe(false);
  });

  it('vault キーの型は D方式 (キー名) で解決される — hoge は text', () => {
    const opts = buildKeyOptions({}, [{ key: 'hoge', count: 1 }], new Set());
    expect(findKey(opts, 'hoge')?.type).toBe('text');
    // 既知キー status は select に解決
    expect(findKey(opts, 'status')?.type).toBe('select');
  });
});

describe('filterKeyOptions / canCreateNewKey', () => {
  const opts = buildKeyOptions({}, [{ key: 'hoge', count: 1 }], new Set());

  it('key + search 語で部分一致絞り込みする', () => {
    const hits = filterKeyOptions(opts, 'sta');
    expect(hits.some((o) => o.key === 'status')).toBe(true);
    expect(hits.some((o) => o.key === 'hoge')).toBe(false);
  });

  it('既存候補と完全一致する名前では新規作成を出さない (空も不可)', () => {
    expect(canCreateNewKey('status', opts)).toBe(false); // 既知キー
    expect(canCreateNewKey('hoge', opts)).toBe(false); // vault キー
    expect(canCreateNewKey('', opts)).toBe(false);
    expect(canCreateNewKey('まったく新しい', opts)).toBe(true);
  });
});

describe('summaryEntriesFor (畳み時の値要約)', () => {
  const mk = (n: number): PropEntry[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'scalar', key: `k${i}`, value: i }) as PropEntry);

  it('上限以下なら全件、超過分は more で件数だけ返す', () => {
    expect(summaryEntriesFor(mk(3), 6)).toEqual({ shown: mk(3), more: 0 });
    const r = summaryEntriesFor(mk(10), 6);
    expect(r.shown).toHaveLength(6);
    expect(r.more).toBe(4);
  });

  it('raw (コメント・空行) は要約対象から除外する', () => {
    const entries: PropEntry[] = [
      { kind: 'raw', source: ['# comment'] },
      { kind: 'scalar', key: 'a', value: 1 },
      { kind: 'raw', source: [''] },
    ];
    const r = summaryEntriesFor(entries, 6);
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]).toMatchObject({ key: 'a' });
  });
});
