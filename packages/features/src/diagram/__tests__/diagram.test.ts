/**
 * Mermaid 図 (task #14)。
 * **フェンスはそのまま残る**ことと、図を添える条件を固定する。
 * (Mermaid 本体は重いので、テストでは描画結果を差し込んで確かめる)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { diagram, primeDiagram } from '../diagram'

const CODE = 'graph TD\n  A --> B'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  primeDiagram(CODE, '<svg data-test="diagram"></svg>')
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(diagram)
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

const diagrams = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.diagram')]

describe('Mermaid のフェンス', () => {
  it('図を添える', () => {
    load('```mermaid\n' + CODE + '\n```\n')
    expect(diagrams()).toHaveLength(1)
    expect(diagrams()[0]?.querySelector('svg')).not.toBeNull()
  })

  it('他の言語のフェンスには添えない', () => {
    load('```ts\nconst a = 1\n```\n')
    expect(diagrams()).toHaveLength(0)
  })

  it('カーソルが中に入ると Mermaid のテキストが出る (図も残る)', () => {
    load('```mermaid\n' + CODE + '\n```\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(3))))
    expect(host.querySelectorAll('.mermaid-source.is-editing')).toHaveLength(1)
    expect(diagrams()).toHaveLength(1)
  })

  it('保存される Markdown は動かない', () => {
    const body = '```mermaid\n' + CODE + '\n```\n'
    load(body)
    expect(save()).toBe(body)
  })
})
