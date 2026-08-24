import type { EditorState } from '@milkdown/kit/prose/state'

/**
 * **描画したものは Backspace / Delete で 1 回で消せること。**
 *
 * このアプリの記法 (`![[図.png]]` / `[status:: todo]` / `$x$` …) は decoration で
 * 別の見た目に置き換わり、元のテキストは隠れている。素の Backspace はその隠れた文字を
 * 1 つずつ削るので、**何回押しても消えないように見える** (実機で 2 回報告された)。
 *
 * 記法を隠す機能は、必ずこのヘルパーで「まるごと消す」経路を用意すること。
 */
export interface Range {
  from: number
  to: number
}

/**
 * **隠した範囲の中にカーソルを置かない。**
 *
 * ⚠️ `display:none` にしたテキストは「見えないのに位置がある」状態になり、
 * → を 1 回押すとカーソルだけが飛んで戻る、Delete が効かない、といった
 * 説明のつかない挙動になる (実機で報告された)。**まるごと 1 文字のように振る舞わせる**
 * ため、中に入ったカーソルは進行方向の端へ押し出すこと。
 *
 * 戻り値は移動先の位置。動かす必要が無ければ null。
 */
/**
 * ← / → で隠した範囲を **1 文字のように跨ぐ**。端に居るときだけ反対の端へ移す。
 *
 * ⚠️ 隠したテキストはブラウザから見ると幅ゼロなので、素の矢印だと範囲ごと飛び越えて
 * **隣の文字まで**行ってしまう (実機で「一瞬右に行って戻る」と報告された)。
 *
 * 移動先を返す。跨ぐ必要が無ければ null。
 */
export function stepOverHidden(
  state: EditorState, key: string, ranges: readonly Range[],
): number | null {
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return null
  if (!state.selection.empty) return null
  const at = state.selection.from
  const forward = key === 'ArrowRight'
  const found = ranges.find((range) => (forward ? range.from === at : range.to === at))
  if (found === undefined) return null
  return forward ? found.to : found.from
}

export function caretOutside(
  ranges: readonly Range[], now: number, before: number,
): number | null {
  for (const range of ranges) {
    if (now <= range.from || now >= range.to) continue
    return now >= before ? range.to : range.from
  }
  return null
}

/**
 * カーソルの位置から、まるごと消すべき範囲を選ぶ。
 *
 * - 範囲の**中**にカーソルがある → その範囲
 * - Backspace で範囲の**直後** / Delete で範囲の**直前** → その範囲
 *
 * どれにも当たらなければ null (普通の Backspace に任せる)。
 */
export function rangeToDelete(state: EditorState, back: boolean, ranges: readonly Range[]): Range | null {
  const { empty, from } = state.selection
  if (!empty) return null
  for (const range of ranges) {
    if (from > range.from && from < range.to) return range
    if (back ? from === range.to : from === range.from) return range
  }
  return null
}
