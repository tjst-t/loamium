/**
 * DqlQueryCache ユニットテスト (Sd5c9f4-1 / AC-Sd5c9f4-1-*)。
 *
 * AC-1-1: set→get ヒット (2 回目は miss なし)
 * AC-1-2: deps が正しく取り出せる
 * AC-1-3: キャッシュ破棄・再生成後も同クエリで正しい結果が返る (priority 6)
 * AC-1-4: キャッシュ未設定 (miss) でも get は null を返す
 * AC-1-5: queryHash 不一致 → null (定義変更検出)
 * invalidate scoping: 該当パス deps のみ削除・非該当は残る
 * invalidateAll: 全エントリ消去
 */
import { describe, expect, it } from 'vitest';
import { DqlQueryCache, computeQueryHash } from './dql-cache.js';
import type { NoteMeta } from '@loamium/shared';

function makeMeta(path: string): NoteMeta {
  return { path, title: path, tags: [], folder: '', mtime: 0, size: 0 };
}

describe('DqlQueryCache', () => {
  // ---- get/set ヒット ---------------------------------------------------

  it('[AC-1-1] set→get ヒット', () => {
    const cache = new DqlQueryCache();
    const hash = computeQueryHash('LIST FROM #p');
    const notes = [makeMeta('a.md'), makeMeta('b.md')];
    cache.set('sf1', notes, new Set(['a.md', 'b.md']), hash);

    const result = cache.get('sf1', hash);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[0]?.path).toBe('a.md');
  });

  it('[AC-1-4] ミス: エントリなしは null', () => {
    const cache = new DqlQueryCache();
    expect(cache.get('nope', computeQueryHash('LIST'))).toBeNull();
  });

  it('[AC-1-5] queryHash 不一致 → null (定義変更検出)', () => {
    const cache = new DqlQueryCache();
    const oldHash = computeQueryHash('LIST FROM #old');
    const newHash = computeQueryHash('LIST FROM #new');
    cache.set('sf1', [makeMeta('a.md')], new Set(['a.md']), oldHash);

    // 新しいハッシュでは miss
    expect(cache.get('sf1', newHash)).toBeNull();
    // エントリは自動削除されている
    expect(cache.size).toBe(0);
  });

  // ---- deps ----------------------------------------------------------------

  it('[AC-1-2] deps Set が正しく格納される', () => {
    const cache = new DqlQueryCache();
    const hash = computeQueryHash('LIST');
    cache.set('sf1', [makeMeta('a.md'), makeMeta('b.md')], new Set(['a.md', 'b.md']), hash);
    // invalidate で deps を間接確認
    const removed = cache.invalidate('a.md');
    expect(removed).toEqual(['sf1']);
    // b.md は sf1 依存なので消えた
    expect(cache.get('sf1', hash)).toBeNull();
  });

  // ---- invalidate scoping --------------------------------------------------

  it('invalidate: 該当 deps を持つエントリのみ削除、非該当は残る', () => {
    const cache = new DqlQueryCache();
    const h1 = computeQueryHash('LIST FROM #a');
    const h2 = computeQueryHash('LIST FROM #b');
    cache.set('sf-a', [makeMeta('a.md')], new Set(['a.md']), h1);
    cache.set('sf-b', [makeMeta('b.md')], new Set(['b.md']), h2);

    const removed = cache.invalidate('a.md');
    expect(removed).toEqual(['sf-a']);
    expect(cache.get('sf-a', h1)).toBeNull();        // 削除された
    expect(cache.get('sf-b', h2)).not.toBeNull();    // 残っている
  });

  it('invalidate: 該当なし → 空配列を返す', () => {
    const cache = new DqlQueryCache();
    const h = computeQueryHash('LIST');
    cache.set('sf1', [], new Set(['a.md']), h);

    const removed = cache.invalidate('z.md');  // z.md は deps に含まれない
    expect(removed).toEqual([]);
    expect(cache.size).toBe(1);  // 残っている
  });

  it('invalidate: 複数 SF が同じ path を deps に持つ場合、両方削除して両 id を返す', () => {
    const cache = new DqlQueryCache();
    const h1 = computeQueryHash('Q1');
    const h2 = computeQueryHash('Q2');
    cache.set('sf1', [makeMeta('shared.md')], new Set(['shared.md']), h1);
    cache.set('sf2', [makeMeta('shared.md')], new Set(['shared.md']), h2);

    const removed = cache.invalidate('shared.md');
    expect(removed.sort()).toEqual(['sf1', 'sf2'].sort());
    expect(cache.size).toBe(0);
  });

  // ---- invalidateAll -------------------------------------------------------

  it('invalidateAll: 全エントリを削除する', () => {
    const cache = new DqlQueryCache();
    cache.set('sf1', [], new Set(), computeQueryHash('Q1'));
    cache.set('sf2', [], new Set(), computeQueryHash('Q2'));
    cache.set('sf3', [], new Set(), computeQueryHash('Q3'));
    expect(cache.size).toBe(3);

    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  // ---- priority 6: 再構築可能性 [AC-1-3] -----------------------------------

  it('[AC-1-3] キャッシュ破棄・再生成後も get は null (再実行が必要)', () => {
    const dql = 'LIST FROM #project';
    const hash = computeQueryHash(dql);
    const notes = [makeMeta('proj.md')];

    // 最初のキャッシュインスタンス
    const cache1 = new DqlQueryCache();
    cache1.set('sf1', notes, new Set(['proj.md']), hash);
    expect(cache1.get('sf1', hash)).not.toBeNull();

    // キャッシュを破棄して再生成 → miss (再実行で再構築される)
    const cache2 = new DqlQueryCache();
    expect(cache2.get('sf1', hash)).toBeNull();
  });

  // ---- computeQueryHash ----------------------------------------------------

  it('computeQueryHash は同一入力に対して同一ハッシュを返す', () => {
    const dql = 'LIST FROM #tag WHERE status = "open"';
    expect(computeQueryHash(dql)).toBe(computeQueryHash(dql));
  });

  it('computeQueryHash は異なる入力に対して異なるハッシュを返す', () => {
    expect(computeQueryHash('LIST')).not.toBe(computeQueryHash('LIST FROM #x'));
  });

  it('computeQueryHash は 16 文字の hex 文字列を返す', () => {
    const h = computeQueryHash('LIST');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
