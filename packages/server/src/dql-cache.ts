/**
 * DQL クエリ結果インメモリキャッシュ (Sd5c9f4-1)。
 *
 * 設計原則 (priority 6): キャッシュは使い捨て・ファイルが正。
 * DqlQueryCache は任意のタイミングで破棄・再生成でき、
 * 破棄後は同クエリを再実行すれば正しい結果が得られる。
 * キャッシュが誤ったノートリストを返すことは絶対にない。
 *
 * エントリ構造:
 *   - result      : 解決済み NoteMeta[]
 *   - deps        : クエリ結果に含まれたファイルパスの Set<string>
 *   - queryHash   : DQL 文字列の SHA-256 短縮 (定義変更でキャッシュを無効化)
 *
 * invalidate(changedPath) は changedPath を deps に含む全エントリを削除し、
 * 削除されたエントリの SF ID セットを返す (SSE 配信に使う)。
 * invalidateAll() は全エントリを削除する (PUT /api/smart-folders 時)。
 */
import { createHash } from 'node:crypto';
import type { NoteMeta } from '@loamium/shared';

export interface DqlCacheEntry {
  result: NoteMeta[];
  deps: Set<string>;
  queryHash: string;
}

/** DQL 文字列の SHA-256 を先頭 8 文字に短縮したハッシュ (64bit hex)。 */
export function computeQueryHash(dql: string): string {
  return createHash('sha256').update(dql, 'utf8').digest('hex').slice(0, 16);
}

export class DqlQueryCache {
  private readonly entries = new Map<string, DqlCacheEntry>();

  /**
   * キャッシュを取得する。
   * queryHash が保存済みエントリと一致しない (DQL 定義変更) 場合は null を返す。
   * エントリが存在しない場合も null を返す (miss)。
   */
  get(id: string, queryHash: string): NoteMeta[] | null {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    if (entry.queryHash !== queryHash) {
      // 定義変更 → 古いエントリを削除してキャッシュミスとして扱う
      this.entries.delete(id);
      return null;
    }
    return entry.result;
  }

  /** キャッシュエントリを設定する。 */
  set(id: string, result: NoteMeta[], deps: Set<string>, queryHash: string): void {
    this.entries.set(id, { result, deps, queryHash });
  }

  /**
   * changedPath を deps に含む全エントリを削除し、削除した SF ID の配列を返す。
   * SSE 配信で affectedIds として使う。
   */
  invalidate(changedPath: string): string[] {
    const removed: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.deps.has(changedPath)) {
        this.entries.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** 全エントリを削除する (PUT /api/smart-folders 時 / 新規ファイル追加時)。 */
  invalidateAll(): void {
    this.entries.clear();
  }

  /**
   * 現在キャッシュに存在する全 SF ID の配列を返す。
   * 新規ファイル追加時に invalidateAll() と組み合わせて使う。
   */
  allIds(): string[] {
    return [...this.entries.keys()];
  }

  /** エントリ数 (テスト用)。 */
  get size(): number {
    return this.entries.size;
  }
}
