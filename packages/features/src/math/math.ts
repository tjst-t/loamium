import { $node, $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import remarkMath from 'remark-math'
import katex from 'katex'

/**
 * 数式 `$…$` / `$$…$$` (task #14)。
 *
 * ⚠️ **エディタ側にも math ノードが要る。** shared のプロセッサは remark-math を通しているが、
 * Milkdown 側が素通しだと数式が「ただのテキスト」になり、保存時に `\int_0^1` が
 * `\int\_0^1` へエスケープされて壊れる (実測)。remark-math を Milkdown にも入れ、
 * mdast の math / inlineMath を受けるノードをここで定義する。
 *
 * 表示は NodeView ではなく decoration + widget:
 * **カーソルが中に入ったら素の `$…$` が出る**という他の記法と同じ扱いに揃える。
 */

/** Milkdown の remark に remark-math を足す (shared のプロセッサと同じ構成にする) */
const remarkMathPlugin = $remark('loamium-math', () => remarkMath)

/** `$$…$$` のブロック。中身はテキストのまま持つ (コードと同じ扱い) */
const mathBlockNode = $node('math_block', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  parseDOM: [{ tag: 'div[data-type="math-block"]', preserveWhitespace: 'full' }],
  toDOM: () => ['div', { 'data-type': 'math-block', class: 'math-block' }, 0] as const,
  parseMarkdown: {
    match: ({ type }) => type === 'math',
    runner: (state, node, type) => {
      state.openNode(type).addText(String(node['value'] ?? '')).closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, node.textContent)
    },
  },
}))

/**
 * `$…$` のインライン。**atom にしない** — 中にカーソルを入れて式そのものを直せるようにする
 * (atom だと消して打ち直すしかなくなる)。
 */
const mathInlineNode = $node('math_inline', () => ({
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  code: true,
  parseDOM: [{ tag: 'span[data-type="math-inline"]', preserveWhitespace: 'full' }],
  toDOM: () => ['span', { 'data-type': 'math-inline', class: 'math-inline' }, 0] as const,
  parseMarkdown: {
    match: ({ type }) => type === 'inlineMath',
    runner: (state, node, type) => {
      state.openNode(type).addText(String(node['value'] ?? '')).closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.textContent)
    },
  },
}))

/**
 * 描画。壊れた式は赤く出す (黙って消さない)。
 *
 * ⚠️ **編集の入口をここに持たせる。** 元の式は畳んであるので、描画をクリックできないと
 * 直す手段が無くなる (実機で確認: クリックも矢印キーも効かなかった)。
 * `data-edit-pos` を目印にして、プラグイン側でキャレットを式の中へ入れる。
 */
export function renderMath(formula: string, display: boolean, editPos?: number): HTMLElement {
  const el = document.createElement(display ? 'div' : 'span')
  el.className = `math-render${display ? ' is-display' : ''}`
  el.contentEditable = 'false'
  el.title = '数式を編集する'
  if (editPos !== undefined) el.dataset['editPos'] = String(editPos)
  try {
    el.innerHTML = katex.renderToString(formula, { displayMode: display, throwOnError: true, output: 'html' })
  } catch (error: unknown) {
    el.classList.add('is-broken')
    el.textContent = error instanceof Error
      ? error.message.replace(/^KaTeX parse error: /, '')
      : '数式を読めません'
  }
  return el
}



const mathViewPlugin = new Plugin({
  key: new PluginKey('loamium-math-view'),
  props: {
    decorations(state: EditorState) {
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      state.doc.descendants((node, pos) => {
        const name = node.type.name
        if (name !== 'math_block' && name !== 'math_inline') return true
        const display = name === 'math_block'
        const to = pos + node.nodeSize
        const formula = node.textContent
        // 中にカーソルがあるときは式そのものを見せて直せるようにする
        const editing = selFrom > pos && selTo < to
        decorations.push(Decoration.node(pos, to, {
          class: `${display ? 'math-block' : 'math-inline'} ${editing ? 'is-editing' : 'is-rendered'}`,
        }))
        // ブロックは編集中も描画を並べて出す (直しながら結果が見える)。
        // インラインは並べると `E = mc^2E=mc²` と読めなくなるので、編集中は式だけにする。
        // ⚠️ 編集中に**必ず**描画を消してはいけない: ノート先頭の数式にカーソルが来ただけで
        //    何も見えなくなる (埋め込みで踏んだのと同じ罠)
        if (editing && !display) return false
        // ⚠️ キャレットは式の**末尾**に入れる。先頭 (pos + 1) に置くと、
        //    打った文字がノードの外 (段落側) に入ってしまう (実機で発生)
        decorations.push(Decoration.widget(to, () => renderMath(formula, display, to - 1), {
          side: 1,
          key: `math-${String(pos)}-${formula}`,
          ignoreSelection: true,
        }))
        return false
      })
      return DecorationSet.create(state.doc, decorations)
    },

    handleDOMEvents: {
      /**
       * 描画を押したら、その式の中へキャレットを入れる (= 編集に入る)。
       * ⚠️ **click ではなく mousedown で拾って preventDefault する。**
       * click まで待つとブラウザ側が widget 全体を選んだ状態を作り、こちらの選択を
       * 上書きしてしまう (実機で発生: 打った 1 文字で式がまるごと消えた)。
       */
      mousedown: (view, event) => {
        // ⚠️ SVG の中を押すと target は SVGElement で、HTMLElement ではない。
        //    Element で受けないと図の操作が素通りする (実機で発生)
        const el = event.target instanceof Element ? event.target.closest('[data-edit-pos]') : null
        if (el === null) return false
        const at = Number(el.getAttribute('data-edit-pos'))
        if (!Number.isFinite(at)) return false
        event.preventDefault()
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))))
        view.focus()
        return true
      },
    },
  },
})

export const math = [
  remarkMathPlugin,
  mathBlockNode,
  mathInlineNode,
  $prose(() => mathViewPlugin),
].flat()
