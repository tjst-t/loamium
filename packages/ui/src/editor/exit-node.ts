import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection, type Command } from '@milkdown/kit/prose/state'
import { exitCode } from '@milkdown/kit/prose/commands'

/**
 * ノードを抜ける (ADR-0035 の受け入れ条件 2)。
 *
 * リストやコードブロック・引用から抜けられない、書式が次の行へ引きずられる、というのは
 * ProseMirror 系の古典的な不満で、Markdown ネイティブなユーザーほど強く効く。
 * 後入れが苦しいので最初から作り込む。
 *
 * 挙動: カーソルを含む「doc 直下のブロック」の直後に段落を挿し、そこへカーソルを移す。
 * すでに doc 直下のブロックにいる (= 抜ける先が無い) 場合は false を返し、他のハンドラへ委ねる。
 * 空段落を無限に生やさないためと、Escape を blur (task #2) に通すため。
 */
export const exitToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty) return false

  // コードブロック内は標準の exitCode に任せる (末尾判定や改行の扱いが最適化されている)
  if ($from.parent.type.spec.code) return false

  // doc 直下のブロック (段落・見出しなど) は抜ける先が無い。
  // ここで false を返すことで、Escape は「選択解除して blur」(task #2) に回る
  if ($from.depth <= 1) return false

  const paragraph = state.schema.nodes['paragraph']
  if (!paragraph) return false

  // doc 直下 (depth 1) の祖先ブロックの直後へ抜ける
  const after = $from.after(1)
  const tr = state.tr.insert(after, paragraph.createAndFill() ?? paragraph.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** コードブロックから抜ける → それ以外のノードから抜ける、の順で試す */
const exitAnyBlock: Command = (state, dispatch, view) =>
  exitCode(state, dispatch, view) || exitToParagraph(state, dispatch, view)

/**
 * 選択を解いてエディタから抜ける (task #2 の「ESC で選択解除 / blur」)。
 *
 * ⚠️ **document の keydown では実装できない。** ProseMirror の `captureKeyDown` が
 * Escape を常に `preventDefault` するので、エディタの外からは「誰も処理しなかった Escape」を
 * 見分けられない。抜ける先が無いときの Escape は、この keymap の中で終わらせる。
 */
const blurEditor: Command = (_state, _dispatch, view) => {
  if (view === undefined) return false
  view.dom.blur()
  window.getSelection()?.removeAllRanges()
  return true
}

export const exitNodeKeymap = $prose(() =>
  keymap({
    // コードブロックからも抜けたいので Escape も exitAnyBlock。
    // 抜ける先が無ければ blur する (入れ子の外側から順に抜けていく感覚になる)
    Escape: (state, dispatch, view) => exitAnyBlock(state, dispatch, view) || blurEditor(state, dispatch, view),
    'Mod-Enter': exitAnyBlock,
  }),
)
