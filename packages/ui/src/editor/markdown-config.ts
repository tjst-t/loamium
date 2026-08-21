import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { stringifyOptions } from '@loamium/shared'

/**
 * Milkdown 内部の remark-stringify に `packages/shared` の設定を注入する。
 *
 * **これを忘れると、エディタ経由の保存だけが `make roundtrip` の gate を外れる。**
 * shared 側の設定 (空行数の復元 / `\[` の選択的復元 / hard break / テーブル桁揃え無効) が
 * そのままエディタの出力にも効くようにする。
 *
 * なお shared の `join` は mdast の position を見るが、エディタが組んだツリーには
 * position が無い。その場合は undefined を返して remark の既定に委ねる設計にしてある。
 */
export function applyLoamiumStringifyOptions(ctx: Ctx): void {
  ctx.set(remarkStringifyOptionsCtx, stringifyOptions)
}
