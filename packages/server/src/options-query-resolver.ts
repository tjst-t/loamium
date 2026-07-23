/**
 * 動的選択肢解決サーバーアダプタ (ADR-0031 / S1bd397)。
 *
 * shared の resolveOptionsQuery (pure 関数) と VaultIndex を橋渡しする。
 * REST / CLI / agent ツールすべてがこのアダプタを経由することで同一の候補解決経路を保証する
 * (ADR-0001: 第二のクエリ機構禁止 / ADR-0016: 単一サービス層)。
 */
import { resolveOptionsQuery, DqlParseError, type ResolveOptionsQueryResult } from '@loamium/shared';
import type { VaultIndex } from './noteIndex.js';

export type ResolveDynamicOptionsResult =
  | { ok: true; result: ResolveOptionsQueryResult }
  | { ok: false; errorCode: 'query_syntax'; message: string }
  | { ok: false; errorCode: 'list_only'; message: string };

/**
 * VaultIndex のノート一覧を使って動的選択肢を解決する。
 *
 * @param dql          - DQL LIST クエリ
 * @param vaultIndex   - ビルド済み VaultIndex
 * @param opts         - オプション (topN / resolvedVars)
 */
export function resolveDynamicOptions(
  dql: string,
  vaultIndex: VaultIndex,
  opts?: {
    topN?: number;
    resolvedVars?: Record<string, string>;
  },
): ResolveDynamicOptionsResult {
  const notes = vaultIndex.queryNotes();
  try {
    const result = resolveOptionsQuery(dql, notes, opts?.topN, opts?.resolvedVars);

    // resolveOptionsQuery は LIST 以外を空候補で返すが、サーバー層では明示エラーにする
    // (エラーコードは呼び出し元 route が返す。ここでは list_only を返す)
    // resolveOptionsQuery 内部で ast.type !== 'list' の場合に空候補を返すが、
    // サーバー層でも LIST 以外を 400 list_only として扱うため再チェックする。
    // Note: resolveOptionsQuery は DqlParseError を投げるが、非 LIST は空を返す。
    // list_only 検出のため DQL を再パースする代わりに、候補が空かつ truncated:false のケースに
    // 対処するより、parseQuery を使って type を確認する。
    // → 実装を簡潔にするため: resolveOptionsQuery が非 LIST に対し空を返す挙動を利用し、
    //   サーバールート側で parseQuery の type をチェックする方式を採用。
    // ここでは resolveOptionsQuery が throw した場合のみエラーを返す。
    return { ok: true, result };
  } catch (err) {
    if (err instanceof DqlParseError) {
      return { ok: false, errorCode: 'query_syntax', message: err.message };
    }
    throw err;
  }
}
