/**
 * 絵文字の補完 (task #52)。
 *
 * 大事なのは 2 つ: **入るのは絵文字そのもの** (ショートコードを残さない) と、
 * **半角の `:` だけが対象** (日本語入力中の全角 `：` では出さない)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { emoji, emojiSuggest, loadEmoji, searchEmoji } from '../emoji'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  // jsdom には getClientRects が無く、ProseMirror の scrollIntoView が落ちる
  const empty = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList
  const rect = (): DOMRect => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
  })
  Range.prototype.getClientRects = empty
  Range.prototype.getBoundingClientRect = rect
  Element.prototype.getClientRects = empty
  Element.prototype.getBoundingClientRect = rect

  await loadEmoji() // 候補は読み込み済みの状態で試す
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(emoji).use(commonmark).use(gfm)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove() })

function load(): void {
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)('\n')
    if (!doc) throw new Error('parse failed')
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
  })
  const end = view.state.doc.content.size - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end))))
}

const type = (text: string): void => {
  for (const char of text) view.dispatch(view.state.tr.insertText(char))
}

const save = (): string => {
  let out = ''
  editor.action((ctx) => { out = normalizeForSave(ctx.get(serializerCtx)(view.state.doc)) })
  return out
}

const active = (): ReturnType<typeof emojiSuggest.activeState> => emojiSuggest.activeState(view.state)

describe('データ', () => {
  it('読み込める (1,000 件以上)', async () => {
    const list = await loadEmoji()
    expect(list.length).toBeGreaterThan(1000)
  })

  it('英語で引ける', async () => {
    const list = await loadEmoji()
    expect(searchEmoji('rocket', list)[0]?.char).toBe('🚀')
    expect(searchEmoji('tada', list)[0]?.char).toBe('🎉')
  })

  it('日本語 (かな) でも引ける', async () => {
    const list = await loadEmoji()
    expect(searchEmoji('おめでとう', list)[0]?.char).toBe('🎉')
    expect(searchEmoji('ちゅうい', list)[0]?.char).toBe('⚠️')
  })

  it('前方一致を先に出す', async () => {
    const list = await loadEmoji()
    expect(searchEmoji('fire', list)[0]?.char).toBe('🔥')
  })
})

describe('出す条件', () => {
  it('行頭の半角 : で出る', () => {
    load()
    type(':')
    expect(active()).not.toBeNull()
  })

  it('空白の直後でも出る', () => {
    load()
    type('やった :')
    expect(active()).not.toBeNull()
  })

  it('全角の ： では出さない (日本語入力中)', () => {
    load()
    type('やった：')
    expect(active()).toBeNull()
  })

  it('時刻やURLでは出さない', () => {
    load()
    type('12:3')
    expect(active()).toBeNull()
    load()
    type('https://')
    expect(active()).toBeNull()
  })

  it('打った文字で絞り込まれる', () => {
    load()
    type(':rocket')
    expect(active()?.items[0]?.value).toBe('🚀')
  })
})

describe('入るもの', () => {
  it('絵文字そのものが入る (ショートコードを残さない)', () => {
    load()
    type('リリース :rocket')
    const item = active()?.items[0]
    if (item === undefined) throw new Error('候補が無い')
    emojiSuggest.accept(view, item)
    expect(save()).toBe('リリース 🚀\n')
  })

  it('`:` と入力は消える。直前の空白は残す', () => {
    load()
    type('よし :tada')
    const item = active()?.items[0]
    if (item === undefined) throw new Error('候補が無い')
    emojiSuggest.accept(view, item)
    expect(save()).toBe('よし 🎉\n')
  })
})
