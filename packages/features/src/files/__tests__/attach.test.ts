/**
 * 添付の削除 (task #16)。
 *
 * `![[…]]` の記法は画面上で隠れているので、素の Backspace だと「見えない文字」を
 * 1 つずつ削ることになり、何度押しても画像が消えないように見える。
 * **1 回で埋め込みごと消える**ことを固定する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { attachments, deleteAttachmentAt } from '../attach'

const NOTE = '# 見出し\n\n![[assets/図.png]]\n\nあと。\n'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(attachments)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove() })

function load(markdown: string): void {
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(markdown)
    if (!doc) throw new Error('parse failed')
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
  })
}
const save = (): string => {
  let out = ''
  editor.action((ctx) => { out = normalizeForSave(ctx.get(serializerCtx)(view.state.doc)) })
  return out
}
/** `text` の直前にカーソルを置く */
function caretBefore(text: string): void {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text?.startsWith(text) === true) at = pos
    return at === -1
  })
  if (at === -1) throw new Error(text)
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))))
}

const remove = (back: boolean): boolean => {
  const range = deleteAttachmentAt(view.state, back)
  if (range === null) return false
  view.dispatch(view.state.tr.delete(range.from, range.to))
  return true
}

describe('添付の削除', () => {
  it('次の行の先頭で Backspace すると、埋め込みごと消える', () => {
    load(NOTE)
    caretBefore('あと。')
    expect(remove(true)).toBe(true)
    // ⚠️ Milkdown が空段落に置く `<br />` がファイルに残らないこと
    expect(save()).toBe('# 見出し\n\nあと。\n')
  })

  it('前の行の末尾で Delete しても消える', () => {
    load(NOTE)
    caretBefore('見出し')
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(view.state.selection.from + 3)),
    ))
    expect(remove(false)).toBe(true)
    expect(save()).toBe('# 見出し\n\nあと。\n')
  })

  it('関係ない場所では何もしない (普通の Backspace に任せる)', () => {
    load('ただの段落\n')
    caretBefore('ただの段落')
    expect(remove(true)).toBe(false)
  })

  it('文中の埋め込みは、その `![[…]]` だけを消す', () => {
    load('前 ![[assets/図.png]] 後\n')
    caretBefore('前 ![[assets/図.png]] 後')
    // 埋め込みの中にカーソルを入れる
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(view.state.selection.from + 5)),
    ))
    expect(remove(true)).toBe(true)
    expect(save()).toBe('前  後\n')
  })
})
