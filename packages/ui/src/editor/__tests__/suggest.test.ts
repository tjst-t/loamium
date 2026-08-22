/**
 * 補完の調停 (task #49)。
 *
 * トリガの条件は同時に成立しうる (`#` の直後に `/` を打つ、など)。
 * **どれが勝つかを登録順で明示的に決める**ことを固定する。暗黙のプラグイン順に委ねると、
 * 「なぜか候補が出ない」という見えないバグになる。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { applyLoamiumStringifyOptions } from '../markdown-config'
import { createSuggest, suggestPriority } from '../suggest'
import { $prose } from '@milkdown/kit/utils'
import { editorPlugins, uiFeatures } from '../../features'
import { setEditorEnv, resetEditorEnv } from '../editor-env'
import { wikiLinkSuggest } from '@loamium/features/links/wikilink'
import { tagSuggest } from '@loamium/features/tags/tag'
import { slashSuggest } from '@loamium/features/slash/slash'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  setEditorEnv({
    notes: ['index.md'], tags: ['仕事'], currentPath: 'index.md',
    open: () => {}, create: () => {}, openTag: () => {},
  })
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host)
      applyLoamiumStringifyOptions(ctx)
    })
    .use(editorPlugins(uiFeatures, 'before-preset'))
    .use(commonmark).use(gfm)
    .use(editorPlugins(uiFeatures, 'after-preset'))
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove(); resetEditorEnv() })

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

const openCount = (): number => [
  wikiLinkSuggest.activeState(view.state),
  tagSuggest.activeState(view.state),
  slashSuggest.activeState(view.state),
].filter((active) => active !== null).length

/** 条件が重なる 2 つの suggest を作って、調停そのものを試す */
function makeOverlapping(): { first: ReturnType<typeof createSuggest>; second: ReturnType<typeof createSuggest> } {
  const match = (state: typeof view.state): { from: number; to: number; query: string } | null => {
    const { $from, empty } = state.selection
    if (!empty) return null
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const found = /@([^\s@]*)$/.exec(before)
    if (found === null) return null
    const query = found[1] ?? ''
    return { from: $from.pos - query.length, to: $from.pos, query }
  }
  return {
    first: createSuggest({ name: 'test-first', header: () => '1', match, items: () => [{ title: 'a', value: 'a' }] }),
    second: createSuggest({ name: 'test-second', header: () => '2', match, items: () => [{ title: 'b', value: 'b' }] }),
  }
}

describe('補完の調停', () => {
  it('登録された suggest の優先順が分かる', () => {
    expect(suggestPriority().slice(0, 3)).toEqual([
      'loamium-slash', 'loamium-wikilink-suggest', 'loamium-tag-suggest',
    ])
  })

  it('条件が重なったとき、開くのは先に登録された 1 つだけ', async () => {
    const { first, second } = makeOverlapping()
    const el = document.createElement('div')
    document.body.append(el)
    const editor2 = await Editor.make()
      .config((ctx) => { ctx.set(rootCtx, el); applyLoamiumStringifyOptions(ctx) })
      .use($prose(() => first)).use($prose(() => second))
      .use(commonmark)
      .create()
    let view2!: EditorView
    editor2.action((ctx) => { view2 = ctx.get(editorViewCtx) })

    view2.dispatch(view2.state.tr.insertText('@'))
    expect(first.activeState(view2.state)).not.toBeNull()
    expect(second.activeState(view2.state)).toBeNull()

    await editor2.destroy()
    el.remove()
  })

  it('実際のトリガ同士は条件が重ならないように作ってある', () => {
    load()
    // タグの直後に `/` を打っても、スラッシュは「行頭か空白の直後」しか拾わない
    type('#メモ/')
    expect(slashSuggest.activeState(view.state)).toBeNull()
    expect(openCount()).toBe(1)
  })

  it('条件が 1 つしか成立しないときは、それが開く', () => {
    load()
    type('#仕')
    expect(tagSuggest.activeState(view.state)).not.toBeNull()
    expect(openCount()).toBe(1)
  })
})
