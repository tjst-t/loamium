/**
 * インラインフィールドの見せ方 (task #19)。
 *
 * 差し込んだ直後に**ピルが出ている**ことを固定する。出ていないと押せず、
 * どんな値が選べるのかも分からない (実機で「最初の 1 回だけメニューが出ない」)。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { taskFields, fieldsOf } from '../task-fields'
import { rangeToDelete } from '@loamium/ui/src/editor/hidden-range'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  // 語彙はサーバーから取る。テストでは固定のものを返す
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    status: [{ key: 'todo', label: '未着手' }, { key: 'done', label: '完了', done: true }],
    priority: [{ key: 'high', label: '高' }],
  }), { headers: { 'content-type': 'application/json' } })))
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(taskFields)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove(); vi.unstubAllGlobals() })

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
const caretAtEndOf = (text: string): number => {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text === text) at = pos + text.length
    return at === -1
  })
  if (at === -1) throw new Error(text)
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))))
  return at
}

describe('インラインフィールド', () => {
  it('カーソルが末尾のすぐ後ろにあってもピルは出る (差し込んだ直後に押せる)', () => {
    load('- [ ] やること\n')
    const at = caretAtEndOf('やること')
    view.dispatch(view.state.tr.insertText(' [status:: todo]', at))
    expect(host.querySelectorAll('.task-field')).toHaveLength(1)
    expect(host.querySelector('.task-field')?.textContent).toBe('未着手')
  })

  it('カーソルが来てもピルのまま (隠したテキストの上を歩かせない)', () => {
    // ⚠️ 以前はカーソルが中に入ると生の `[status:: todo]` に戻していたが、
    //    隠れた位置にカーソルを置けてしまい、→ で飛んで戻る・Delete が効かない
    //    といった挙動になっていた。中身はメニューか `.md` で直す
    load('- [ ] やること [status:: todo]\n')
    const field = fieldsOf(view.state)[0]
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve((field?.from ?? 0) + 3)),
    ))
    expect(host.querySelectorAll('.task-field')).toHaveLength(1)
    // カーソルは範囲の中に残らない (端へ押し出される)
    expect([field?.from, field?.to]).toContain(view.state.selection.from)
  })

  it('← / → はピルを 1 文字として跨ぐ', async () => {
    const { stepOverHidden } = await import('@loamium/ui/src/editor/hidden-range')
    load('- [ ] やること [status:: todo] あと\n')
    const field = fieldsOf(view.state)[0]
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(field?.from ?? 0)),
    ))
    expect(stepOverHidden(view.state, 'ArrowRight', fieldsOf(view.state))).toBe(field?.to)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(field?.to ?? 0)),
    ))
    expect(stepOverHidden(view.state, 'ArrowLeft', fieldsOf(view.state))).toBe(field?.from)
  })

  it('Backspace / Delete でフィールドごと 1 回で消える (直前の空白も)', () => {
    load('- [ ] やること [due:: 2026-08-30]\n')
    // フィールドの直後 (行末) にカーソルを置く
    const field = fieldsOf(view.state)[0]
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(field?.to ?? 0)),
    ))
    const range = rangeToDelete(view.state, true, [...fieldsOf(view.state)])
    expect(range).not.toBeNull()
    view.dispatch(view.state.tr.delete((range?.from ?? 0) - 1, range?.to ?? 0))
    expect(save()).toBe('- [ ] やること\n')
  })

  it('チェックボックスの行に文字を足しても壊れない', () => {
    // ⚠️ 完了と status の同期で、新しい doc の位置を古い doc に渡して
    //    RangeError で本文が消える事故があった
    load('# 見出し\n\n- [ ] やること\n- [ ] もうひとつ\n')
    const at = caretAtEndOf('やること')
    expect(() => { view.dispatch(view.state.tr.insertText(' [due:: 2026-08-30]', at)) }).not.toThrow()
    expect(save()).toBe('# 見出し\n\n- [ ] やること [due:: 2026-08-30]\n- [ ] もうひとつ\n')
  })
})
