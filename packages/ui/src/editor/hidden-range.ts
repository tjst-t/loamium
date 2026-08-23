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
