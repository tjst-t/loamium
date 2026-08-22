/**
 * 選択バブル (task #50)。
 * 判定は「変換後に保存される Markdown」。出るのは往復できる記法だけ。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { format, FORMAT_ACTIONS, shouldShowBubble } from '../format'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(format)
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

/** 本文の `text` を選択する */
function select(text: string): void {
  const body = view.state.doc.textBetween(0, view.state.doc.content.size, '\n')
  const at = body.indexOf(text)
  if (at < 0) throw new Error(`本文に無い: ${text}`)
  // 段落 1 つ想定 (先頭の位置 1 からの相対)
  const from = at + 1
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length)))
}

const run = (id: string): void => {
  const action = FORMAT_ACTIONS.find((entry) => entry.id === id)
  if (action === undefined) throw new Error(`無い変換: ${id}`)
  action.run(view.state, view.dispatch.bind(view), view)
}

describe('出す条件', () => {
  it('選択が無ければ出さない', () => {
    load('ふつうの段落\n')
    expect(shouldShowBubble(view.state)).toBe(false)
  })

  it('文字を選択したら出す', () => {
    load('ふつうの段落\n')
    select('ふつう')
    expect(shouldShowBubble(view.state)).toBe(true)
  })

  it('空白だけの選択では出さない', () => {
    load('あ い\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 3)))
    expect(shouldShowBubble(view.state)).toBe(false)
  })

  it('コードブロックの中では出さない (記法が効かない)', () => {
    load('```\nconst a = 1\n```\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 7)))
    expect(shouldShowBubble(view.state)).toBe(false)
  })
})

describe('変換した結果 (保存される Markdown)', () => {
  it('太字', () => {
    load('これは強調です\n')
    select('強調')
    run('strong')
    expect(save()).toBe('これは**強調**です\n')
  })

  it('斜体', () => {
    load('これは emphasis です\n')
    select('emphasis')
    run('emphasis')
    // 斜体のマーカーは shared の正規形に従う (`_`)
    expect(save()).toBe('これは _emphasis_ です\n')
  })

  it('インラインコード', () => {
    load('値は const です\n')
    select('const')
    run('code')
    expect(save()).toBe('値は `const` です\n')
  })

  it('取り消し線', () => {
    load('これは古い情報です\n')
    select('古い情報')
    run('strike')
    expect(save()).toBe('これは~~古い情報~~です\n')
  })

  it('ノートへのリンク', () => {
    load('関連は プロジェクト Hydra です\n')
    select('プロジェクト Hydra')
    run('wikilink')
    expect(save()).toBe('関連は [[プロジェクト Hydra]] です\n')
  })

  it('もう一度かけると外れる', () => {
    load('これは強調です\n')
    select('強調')
    run('strong')
    select('強調')
    run('strong')
    expect(save()).toBe('これは強調です\n')
  })

  it('いまかかっている変換が分かる (ボタンの状態)', () => {
    load('これは**強調**です\n')
    select('強調')
    const strong = FORMAT_ACTIONS.find((a) => a.id === 'strong')
    const code = FORMAT_ACTIONS.find((a) => a.id === 'code')
    expect(strong?.isActive(view.state)).toBe(true)
    expect(code?.isActive(view.state)).toBe(false)
  })
})
