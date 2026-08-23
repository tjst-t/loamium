/**
 * 数式 `$…$` / `$$…$$` (task #14)。
 *
 * shared のプロセッサは remark-math を通しているので数式はもともと往復する。
 * ここで固定するのは「見せ方が本文を変えないこと」と、拾い方の正しさ。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { math, renderMath } from '../math'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(math)
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

const rendered = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.math-render')]

describe('描画', () => {
  it('KaTeX が式を組む', () => {
    const el = renderMath('E = mc^2', false)
    expect(el.querySelector('.katex')).not.toBeNull()
    expect(el.className).not.toContain('is-broken')
  })

  it('壊れた式は赤く出す (黙って消さない)', () => {
    const el = renderMath('\\frac{', false)
    expect(el.className).toContain('is-broken')
    expect(el.textContent).not.toBe('')
  })
})

describe('エディタの中', () => {
  it('数式が描画される', () => {
    load('式は $E = mc^2$ です\n')
    expect(rendered()).toHaveLength(1)
  })

  it('ブロック数式も描画される', () => {
    load('$$\n\\int_0^1 x dx\n$$\n')
    expect(rendered()).toHaveLength(1)
  })

  it('中にカーソルを置くと式そのものが出る (描画は消えない)', () => {
    load('$$\n\\int_0^1 x dx\n$$\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(3))))
    expect(host.querySelectorAll('.math-block.is-editing')).toHaveLength(1)
    expect(rendered()).toHaveLength(1)
  })

  it('カーソルが外にあるときは式を畳んで描画だけ見せる', () => {
    load('式は $E = mc^2$ です\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(1))))
    expect(host.querySelectorAll('.math-inline.is-rendered')).toHaveLength(1)
    expect(rendered()).toHaveLength(1)
  })

  it('コードの中は数式にしない', () => {
    load('```\n$E = mc^2$\n```\n')
    expect(rendered()).toHaveLength(0)
  })

  it('数式でない $ は数式にしない', () => {
    load('1 ドルは \\$100 です\n')
    expect(rendered()).toHaveLength(0)
  })

  it('保存される Markdown は動かない (インライン)', () => {
    const body = '式は $E = mc^2$ です\n'
    load(body)
    expect(save()).toBe(body)
  })

  it('保存される Markdown は動かない (ブロック)', () => {
    const body = '$$\n\\int_0^1 x dx\n$$\n'
    load(body)
    expect(save()).toBe(body)
  })
})
