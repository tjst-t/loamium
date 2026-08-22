/**
 * ノードを抜ける挙動 (ADR-0035 の受け入れ条件 2)。
 *
 * 「リストやコードブロックから抜けられない」は ProseMirror 系の古典的な不満なので、
 * 抜けられること **と** 抜ける先が無いときに黙って false を返すこと (= Escape が
 * エディタの blur に回ること / 空段落を生やさないこと) の両方を固定する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '../markdown-config'
import { exitNodeKeymap, exitToParagraph } from '../exit-node'
import { outline } from '@loamium/features/outline/outline'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host)
      applyLoamiumStringifyOptions(ctx)
    })
    .use(commonmark).use(gfm).use(exitNodeKeymap).use(outline)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove() })

/** Markdown を読み込み、`line` 番目の textblock の末尾にカーソルを置く */
function load(markdown: string, line = 0): void {
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(markdown)
    if (!doc) throw new Error('parse failed')
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
  })
  const ends: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) ends.push(pos + node.nodeSize - 1)
    return true
  })
  const target = ends[line]
  if (target === undefined) throw new Error(`no textblock at line ${line}`)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
}

const save = (): string => {
  let out = ''
  editor.action((ctx) => { out = normalizeForSave(ctx.get(serializerCtx)(view.state.doc)) })
  return out
}

const exit = (): boolean => exitToParagraph(view.state, view.dispatch.bind(view), view)

describe('Escape / Mod-Enter でノードを抜ける', () => {
  it('リスト項目から抜けて doc 直下の素の段落へ移る', () => {
    load('- a\n', 0)
    expect(exit()).toBe(true)
    expect(view.state.selection.$from.depth).toBe(1)
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    // 抜けただけでは本文は変わらない (空段落は正規化で落ちる)
    expect(save()).toBe('- a\n')
  })

  it('引用から抜ける', () => {
    load('> 引用\n', 0)
    expect(exit()).toBe(true)
    // 抜けた先の空段落に入力できる = 引用の外に段落がある
    expect(view.state.selection.$from.depth).toBe(1)
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
  })

  it('doc 直下の段落では false (空段落を生やさない)', () => {
    load('ふつうの段落\n', 0)
    expect(exit()).toBe(false)
    expect(save()).toBe('ふつうの段落\n')
  })

  it('doc 直下の見出しでも false (Escape は blur に回す)', () => {
    load('# 見出し\n', 0)
    expect(exit()).toBe(false)
    expect(save()).toBe('# 見出し\n')
  })
})
