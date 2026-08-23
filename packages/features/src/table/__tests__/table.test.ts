/**
 * 表の WYSIWYG 編集 (task #15)。
 *
 * 守るのは 2 つ:
 * 1. 行・列の追加/削除/移動が **保存後の Markdown に正しく出る** (round-trip gate と同じ正規形)
 * 2. **見出し行を壊す操作は塞ぐ** (GFM の表は見出し必須。消せると表ごと消えたように見える)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { TABLE_ACTIONS, cellRect, table } from '../table'

const TABLE = [
  '| 名前 | 役割 |',
  '| - | - |',
  '| メモ | 素材 |',
  '| ノート | 成果 |',
  '',
].join('\n')

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(table)
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

/** `text` を含むセルにカーソルを置く */
function caretIn(text: string): void {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text === text) at = pos + 1
    return at === -1
  })
  if (at === -1) throw new Error(`セルが見つからない: ${text}`)
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))))
}

const act = (id: string): boolean => {
  const action = TABLE_ACTIONS.find((a) => a.id === id)
  if (action === undefined) throw new Error(id)
  return action.run(view.state, view.dispatch.bind(view), view)
}
const enabled = (id: string): boolean => {
  const action = TABLE_ACTIONS.find((a) => a.id === id)
  if (action === undefined) throw new Error(id)
  return action.enabled(view.state)
}

describe('表の操作', () => {
  it('表の外ではセルの位置が取れない (バーも出ない)', () => {
    load('ただの段落\n')
    expect(cellRect(view.state)).toBeNull()
  })

  it('下に行を追加できる', () => {
    load(TABLE)
    caretIn('メモ')
    expect(act('row-add')).toBe(true)
    expect(save()).toBe([
      '| 名前 | 役割 |',
      '| - | - |',
      '| メモ | 素材 |',
      '| | |',
      '| ノート | 成果 |',
      '',
    ].join('\n'))
  })

  it('行を削除できる', () => {
    load(TABLE)
    caretIn('メモ')
    expect(act('row-del')).toBe(true)
    expect(save()).toBe('| 名前 | 役割 |\n| - | - |\n| ノート | 成果 |\n')
  })

  it('行を下へ動かせる', () => {
    load(TABLE)
    caretIn('メモ')
    expect(act('row-down')).toBe(true)
    expect(save()).toBe('| 名前 | 役割 |\n| - | - |\n| ノート | 成果 |\n| メモ | 素材 |\n')
  })

  it('右に列を追加でき、列も動かせる', () => {
    load(TABLE)
    caretIn('名前')
    expect(act('col-add')).toBe(true)
    expect(save()).toBe([
      '| 名前 | | 役割 |',
      '| - | - | - |',
      '| メモ | | 素材 |',
      '| ノート | | 成果 |',
      '',
    ].join('\n'))
    caretIn('役割')
    expect(act('col-left')).toBe(true)
    expect(save()).toBe([
      '| 名前 | 役割 | |',
      '| - | - | - |',
      '| メモ | 素材 | |',
      '| ノート | 成果 | |',
      '',
    ].join('\n'))
  })

  it('列を削除できる', () => {
    load(TABLE)
    caretIn('役割')
    expect(act('col-del')).toBe(true)
    expect(save()).toBe('| 名前 |\n| - |\n| メモ |\n| ノート |\n')
  })

  it('見出し行は消せず、動かせもしない', () => {
    load(TABLE)
    caretIn('名前')
    expect(enabled('row-del')).toBe(false)
    expect(enabled('row-down')).toBe(false)
    expect(enabled('row-up')).toBe(false)
    // 本文の行なら消せる
    caretIn('メモ')
    expect(enabled('row-del')).toBe(true)
  })

  it('端の行・列はそれ以上動かせない / 1 列の表は列を消せない', () => {
    load(TABLE)
    caretIn('メモ')
    expect(enabled('row-up')).toBe(false)   // すぐ上は見出し行
    caretIn('ノート')
    expect(enabled('row-down')).toBe(false) // 最終行
    caretIn('名前')
    expect(enabled('col-left')).toBe(false)
    load('| a |\n| - |\n| b |\n')
    caretIn('b')
    expect(enabled('col-del')).toBe(false)
  })

  it('表ごと削除できる', () => {
    load(TABLE)
    caretIn('メモ')
    expect(act('table-del')).toBe(true)
    expect(save().includes('|')).toBe(false)
  })
})
