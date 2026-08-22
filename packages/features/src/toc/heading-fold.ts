import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { notify, registerEditorView } from './toc-store'

/**
 * 見出しの折りたたみ (task #11)。
 *
 * ある見出しを畳むと、**次の同じか上位の見出しが来るまで**の間の兄弟ノードを隠す。
 * リストの折りたたみ (task #10) と同じく **decoration だけで表現し、ドキュメントには
 * 一切書き込まない** (不変条件 1: 折りたたみ状態は文書の一部ではない)。
 */
export const headingFoldKey = new PluginKey<DecorationSet>('loamium-heading-fold')

export interface Section {
  /** 見出しノードの位置 */
  pos: number
  level: number
  text: string
  /** この見出しが畳まれているか */
  folded: boolean
  /** 畳める中身があるか (次の見出しまでに何かあるか) */
  foldable: boolean
  /** 畳まれた上位の見出しの中に隠れているか */
  hidden: boolean
}

const isHeading = (node: ProseNode): boolean => node.type.name === 'heading'
const levelOf = (node: ProseNode): number => Number(node.attrs['level'] ?? 1)

/**
 * doc 直下を走査して、見出しと「その見出しに属する範囲」を組み立てる。
 * 目次パネルもこれを使う (画面に出ている構造と目次を必ず一致させるため)。
 */
export function sectionsOf(state: EditorState, foldedPositions: ReadonlySet<number>): Section[] {
  const sections: Section[] = []
  const doc = state.doc
  const tops: { node: ProseNode; pos: number }[] = []
  doc.forEach((node, offset) => { tops.push({ node, pos: offset }) })

  // 畳まれた見出しの範囲に入っている間は hideAbove にその見出しの階層を持つ
  let hideAbove: number | null = null
  for (const [i, entry] of tops.entries()) {
    if (!isHeading(entry.node)) continue
    const level = levelOf(entry.node)
    if (hideAbove !== null && level <= hideAbove) hideAbove = null

    let foldable = false
    const next = tops[i + 1]
    if (next !== undefined && !(isHeading(next.node) && levelOf(next.node) <= level)) foldable = true

    const hidden = hideAbove !== null
    const folded = foldedPositions.has(entry.pos)
    sections.push({ pos: entry.pos, level, text: entry.node.textContent, folded, foldable, hidden })
    if (!hidden && folded) hideAbove = level
  }
  return sections
}

/** 畳まれた見出しの配下 (隠すべき範囲) を列挙する */
function hiddenRanges(state: EditorState, folded: ReadonlySet<number>): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  const tops: { node: ProseNode; pos: number }[] = []
  state.doc.forEach((node, offset) => { tops.push({ node, pos: offset }) })

  for (const [i, entry] of tops.entries()) {
    if (!isHeading(entry.node) || !folded.has(entry.pos)) continue
    const level = levelOf(entry.node)
    for (let j = i + 1; j < tops.length; j += 1) {
      const next = tops[j]
      if (next === undefined) break
      if (isHeading(next.node) && levelOf(next.node) <= level) break
      ranges.push({ from: next.pos, to: next.pos + next.node.nodeSize })
    }
  }
  return ranges
}

const foldedPositionsOf = (set: DecorationSet): Set<number> =>
  new Set(set.find().map((deco) => deco.from))

export function foldedHeadings(state: EditorState): Set<number> {
  return foldedPositionsOf(headingFoldKey.getState(state) ?? DecorationSet.empty)
}

/** 見出しの折りたたみを切り替える (位置指定。省略時はカーソルのある見出し) */
export function toggleHeadingFoldAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { pos }))
}

export const toggleHeadingFold: Command = (state, dispatch) => {
  const { $from } = state.selection
  // カーソルのあるブロックが見出しか、直前の見出しを探す
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth)
    if (!isHeading(node)) continue
    const pos = $from.before(depth)
    dispatch?.(state.tr.setMeta(headingFoldKey, { pos }))
    return true
  }
  return false
}

function toggleButton(view: EditorView, pos: number, folded: boolean): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'heading-fold-toggle'
  button.setAttribute('aria-expanded', String(!folded))
  button.setAttribute('aria-label', folded ? '節を開く' : '節を畳む')
  button.contentEditable = 'false'
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    toggleHeadingFoldAt(view, pos)
  })
  return button
}

const headingFoldPlugin = new Plugin<DecorationSet>({
  key: headingFoldKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc)
      const meta = tr.getMeta(headingFoldKey) as { pos: number } | undefined
      if (meta === undefined) return next
      const existing = next.find(meta.pos, meta.pos + 1).find((deco) => deco.from === meta.pos)
      if (existing !== undefined) return next.remove([existing])
      const node = tr.doc.nodeAt(meta.pos)
      if (node === null || !isHeading(node)) return next
      return next.add(tr.doc, [
        Decoration.node(meta.pos, meta.pos + node.nodeSize, { class: 'is-folded' }, { headingFold: true }),
      ])
    },
  },

  props: {
    decorations(state) {
      const folded = foldedHeadings(state)
      const decorations: Decoration[] = []
      // 畳まれた見出し自身 (「…」を出すため) と、その配下
      for (const deco of (headingFoldKey.getState(state) ?? DecorationSet.empty).find()) decorations.push(deco)
      for (const range of hiddenRanges(state, folded)) {
        decorations.push(Decoration.node(range.from, range.to, { class: 'is-folded-away' }))
      }
      // 畳める見出しにはつまみを出す
      for (const section of sectionsOf(state, folded)) {
        if (!section.foldable) continue
        decorations.push(Decoration.widget(
          section.pos + 1,
          (view) => toggleButton(view, section.pos, section.folded),
          { side: -1, key: `heading-fold-${String(section.pos)}-${String(section.folded)}`, ignoreSelection: true },
        ))
      }
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

/** 目次パネルへ「いまのビュー」と更新を届ける */
const viewBridge = new Plugin({
  key: new PluginKey('loamium-toc-bridge'),
  view: (view) => {
    registerEditorView(view)
    return {
      update: () => { notify() },
      destroy: () => { registerEditorView(null) },
    }
  },
})

export const headingFold = [
  $prose(() => headingFoldPlugin),
  $prose(() => viewBridge),
  // リストの折りたたみ (task #10) と同じキー。リスト側が拾わなければこちらが受ける
  $prose(() => keymap({ 'Mod-.': toggleHeadingFold })),
]
