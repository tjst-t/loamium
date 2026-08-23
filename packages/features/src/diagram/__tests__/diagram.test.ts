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

  it('ホバーで操作バーが出て、「編集」からフェンスに入る', () => {
    // 末尾に段落を置き、キャレットをフェンスの外に出しておく
    load('```mermaid\n' + CODE + '\n```\n\n本文\n')
    view.dispatch(view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(view.state.doc.content.size - 1)),
    ))
    const box = diagrams()[0]
    if (box === undefined) throw new Error('図が無い')
    box.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    const labels = [...document.querySelectorAll('.block-action')].map((b) => b.textContent)
    expect(labels).toEqual(['編集', '画像をコピー', 'テキストをコピー'])
    // 出しただけでは編集に入らない
    expect(host.querySelectorAll('.mermaid-source.is-editing')).toHaveLength(0)

    const edit = [...document.querySelectorAll('.block-action')].find((b) => b.textContent === '編集')
    edit?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(host.querySelectorAll('.mermaid-source.is-editing')).toHaveLength(1)
    document.querySelector('.block-actions')?.remove()
  })

  it('widget の key は「中身」と「描画状態」の両方で変わる', () => {
    // ⚠️ どちらかが欠けると実機で止まる:
    //    中身が無い → 書き換えても DOM が再利用され、新しい図が描かれない
    //    状態が無い → 描き終わっても「描いています…」のまま止まる
    load('```mermaid\n' + CODE + '\n```\n')
    const keyOf = (): string => {
      for (const plugin of view.state.plugins) {
        const set = plugin.props.decorations?.call(plugin, view.state) as
          { find?: () => { type: { spec?: { key?: string } } }[] } | undefined
        for (const deco of set?.find?.() ?? []) {
          const key = deco.type.spec?.key
          if (key !== undefined && key.startsWith('diagram-')) return key
        }
      }
      return ''
    }
    const ready = keyOf()
    expect(ready).toContain('ready')      // 差し込み済みなので ready
    expect(ready).toContain(CODE)         // 中身が入っている

    load('```mermaid\ngraph LR\n  X --> Y\n```\n')
    const loading = keyOf()
    expect(loading).not.toBe(ready)
    expect(loading).toContain('loading')  // まだ描いていない
  })

  it('保存される Markdown は動かない', () => {
    const body = '```mermaid\n' + CODE + '\n```\n'
    load(body)
    expect(save()).toBe(body)
  })
})
