import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { toggleMark } from '@milkdown/kit/prose/commands'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { MarkType } from '@milkdown/kit/prose/model'

/**
 * 選択したテキストの変換 (task #50)。
 *
 * **モバイルには Mod+B が無い。** 選択に対する変換の入口はこのバブルだけなので、
 * 「あると良い」ではなく必須のものとして扱う (docs/DESIGN/mobile.md)。
 *
 * 出すのは**往復できる記法だけ**。装飾のためのボタンは置かない。
 */
export interface FormatAction {
  id: string
  label: string
  /** ボタンに出す短い記号 (等幅で組む。ディスク上の記法そのもの) */
  glyph: string
  /** いまその変換がかかっているか */
  isActive: (state: EditorState) => boolean
  run: Command
}

const markOf = (state: EditorState, name: string): MarkType | undefined => state.schema.marks[name]

function markIsActive(state: EditorState, name: string): boolean {
  const type = markOf(state, name)
  if (type === undefined) return false
  const { from, to, empty, $from } = state.selection
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) != null
  return state.doc.rangeHasMark(from, to, type)
}

function toggle(name: string): Command {
  return (state, dispatch, view) => {
    const type = markOf(state, name)
    return type === undefined ? false : toggleMark(type)(state, dispatch, view)
  }
}

/** 選択した文字列を記号で挟む (`==…==` のようなマークではない記法) */
function wrapWith(open: string, close: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) return false
    const text = state.doc.textBetween(from, to, ' ')
    if (text.trim() === '') return false
    // すでに挟まれていれば外す
    const wrapped = text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length
    const next = wrapped ? text.slice(open.length, text.length - close.length) : `${open}${text}${close}`
    const tr = state.tr.insertText(next, from, to)
    tr.setSelection(TextSelection.create(tr.doc, from, from + next.length))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** 選択した文字列を `[[…]]` にする。ノートが無ければ壊れリンクとして赤く出る */
const toWikiLink: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection
  if (empty) return false
  const text = state.doc.textBetween(from, to, ' ')
  if (text.trim() === '') return false
  const tr = state.tr.insertText(`[[${text}]]`, from, to)
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + text.length + 4)))
  dispatch?.(tr.scrollIntoView())
  return true
}

export const FORMAT_ACTIONS: FormatAction[] = [
  { id: 'strong', label: '太字', glyph: '**', isActive: (s) => markIsActive(s, 'strong'), run: toggle('strong') },
  { id: 'emphasis', label: '斜体', glyph: '*', isActive: (s) => markIsActive(s, 'emphasis'), run: toggle('emphasis') },
  { id: 'code', label: 'コード', glyph: '`', isActive: (s) => markIsActive(s, 'inlineCode'), run: toggle('inlineCode') },
  { id: 'strike', label: '取り消し線', glyph: '~~', isActive: (s) => markIsActive(s, 'strike_through'), run: toggle('strike_through') },
  { id: 'highlight', label: 'ハイライト', glyph: '==', isActive: () => false, run: wrapWith('==', '==') },
  { id: 'wikilink', label: 'ノートへリンク', glyph: '[[]]', isActive: () => false, run: toWikiLink },
]

/** バブルを出すべき選択か (テストからも使う) */
export function shouldShowBubble(state: EditorState): boolean {
  const { empty, from, to, $from } = state.selection
  if (empty) return false
  if ($from.parent.type.spec.code === true) return false
  return state.doc.textBetween(from, to, ' ').trim() !== ''
}

const bubbleKey = new PluginKey('loamium-format-bubble')

function build(view: EditorView, dom: HTMLElement): void {
  dom.replaceChildren()
  for (const action of FORMAT_ACTIONS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `format-button${action.isActive(view.state) ? ' is-active' : ''}`
    button.title = action.label
    button.setAttribute('aria-label', action.label)
    button.setAttribute('aria-pressed', String(action.isActive(view.state)))
    button.textContent = action.glyph
    // mousedown で実行する (click まで待つと選択が消える)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      action.run(view.state, view.dispatch.bind(view), view)
      view.focus()
    })
    dom.append(button)
  }
}

function place(view: EditorView, dom: HTMLElement): void {
  const { from, to } = view.state.selection
  try {
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    const box = dom.getBoundingClientRect()
    const left = Math.min(Math.max((start.left + end.left) / 2 - box.width / 2, 8), window.innerWidth - box.width - 8)
    // 上に出す。上が詰まっていたら下へ回す (モバイルの選択ハンドルを避ける)
    const above = start.top - box.height - 8
    dom.style.left = `${String(Math.round(left))}px`
    dom.style.top = `${String(Math.round(above > 8 ? above : end.bottom + 12))}px`
  } catch { /* 座標が取れない環境 (jsdom) では位置決めを諦める */ }
}

const bubblePlugin = new Plugin({
  key: bubbleKey,
  view(view) {
    const dom = document.createElement('div')
    dom.className = 'format-bubble'
    dom.style.display = 'none'
    document.body.append(dom)

    const render = (v: EditorView): void => {
      if (!shouldShowBubble(v.state) || !v.hasFocus()) {
        dom.style.display = 'none'
        return
      }
      build(v, dom)
      dom.style.display = 'flex'
      place(v, dom)
    }
    render(view)
    return { update: render, destroy: () => { dom.remove() } }
  },
})

export const format = [$prose(() => bubblePlugin)]
