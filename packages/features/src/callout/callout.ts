import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/**
 * callout とハイライト (task #13)。
 *
 * どちらも**スキーマを触らない**。callout は「1 行目が `[!種別]` で始まる引用」、
 * ハイライトは「`==…==` というただのテキスト」で、Obsidian の既存慣行にそのまま乗る。
 * decoration で見た目だけを足すので、serializer には一切影響しない (不変条件 2)。
 */

/** 対応する種別。Obsidian の一般的なものに絞る */
const TYPES = ['note', 'tip', 'info', 'warning', 'danger', 'quote', 'example'] as const
export type CalloutType = (typeof TYPES)[number]

const TYPE_SET = new Set<string>(TYPES)

export interface CalloutHead {
  type: CalloutType
  /** `[!note] ここ` のタイトル部分 */
  title: string
  /** `[!note]` の文字数 (隠す範囲) */
  markerLength: number
}

/** 引用の 1 行目が callout の見出しなら、その中身を返す */
export function parseCalloutHead(firstLine: string): CalloutHead | null {
  const m = /^\[!([a-zA-Z]+)\]\s*(.*)$/.exec(firstLine)
  if (m === null) return null
  const type = (m[1] ?? '').toLowerCase()
  if (!TYPE_SET.has(type)) return null
  return {
    type: type as CalloutType,
    title: (m[2] ?? '').trim(),
    markerLength: (m[1] ?? '').length + 3,
  }
}

interface Found {
  /** blockquote ノードの位置 */
  pos: number
  node: ProseNode
  head: CalloutHead
}

function calloutsIn(state: EditorState): Found[] {
  const out: Found[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') return true
    const first = node.firstChild
    if (first === null || !first.isTextblock) return true
    // ⚠️ textContent は hardbreak を `\n` として含む。1 行目だけを見る
    //    (`[!note] タイトル\n本文` のとき、行末アンカーが効かず判定を落としていた)
    const head = parseCalloutHead(first.textContent.split('\n')[0] ?? '')
    if (head !== null) out.push({ pos, node, head })
    return true
  })
  return out
}

const calloutPlugin = new Plugin({
  key: new PluginKey('loamium-callout'),
  props: {
    decorations(state) {
      const decorations: Decoration[] = []
      for (const found of calloutsIn(state)) {
        decorations.push(Decoration.node(found.pos, found.pos + found.node.nodeSize, {
          class: `callout callout-${found.head.type}`,
          'data-callout': found.head.type,
        }))
        // `[!note]` の記法そのものは隠す (種別は枠の色とラベルで分かる)
        const first = found.node.firstChild
        if (first === null) continue
        const from = found.pos + 2
        decorations.push(Decoration.inline(from, from + found.head.markerLength, {
          class: 'callout-marker',
        }))
        // 1 行目 (タイトル) だけを太字にする。段落全体ではない
        const firstLine = first.textContent.split('\n')[0] ?? ''
        if (firstLine.length > found.head.markerLength) {
          decorations.push(Decoration.inline(
            from + found.head.markerLength,
            from + firstLine.length,
            { class: 'callout-title' },
          ))
        }
      }
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

/* ------------------------------------------------------------ ハイライト */

/** `==…==` を拾う。`====` のような空のものは対象外 */
const HIGHLIGHT_RE = /==([^=\n]+)==/g

const highlightPlugin = new Plugin({
  key: new PluginKey('loamium-highlight'),
  props: {
    decorations(state) {
      const decorations: Decoration[] = []
      const { from: selFrom, to: selTo } = state.selection
      state.doc.descendants((node, pos, parent) => {
        if (!node.isText || node.text === null || node.text === undefined) return true
        if (parent?.type.spec.code === true) return false
        if (node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === 'inlineCode')) return true
        HIGHLIGHT_RE.lastIndex = 0
        for (let m = HIGHLIGHT_RE.exec(node.text); m !== null; m = HIGHLIGHT_RE.exec(node.text)) {
          const from = pos + m.index
          const to = from + m[0].length
          decorations.push(Decoration.inline(from, to, { class: 'highlight' }))
          // カーソルが触れていないときは `==` を隠す (WikiLink と同じ扱い)
          if (selTo >= from && selFrom <= to) continue
          decorations.push(Decoration.inline(from, from + 2, { class: 'highlight-syntax' }))
          decorations.push(Decoration.inline(to - 2, to, { class: 'highlight-syntax' }))
        }
        return true
      })
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

export const callout = [$prose(() => calloutPlugin), $prose(() => highlightPlugin)]
