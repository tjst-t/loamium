/**
 * 見出しの折りたたみ (task #11)。
 *
 * リストの折りたたみと同じく、**ドキュメントには書き込まない**ことが要。
 * 判定は「隠れる範囲」と「保存した Markdown」の両方で固定する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { foldedHeadings, headingFold, sectionsOf, toggleHeadingFoldAt } from '../heading-fold'

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
    .use(commonmark).use(gfm).use(headingFold)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove() })

const DOC = '# 見出し 1\n\n段落 A\n\n## 見出し 1-1\n\n段落 B\n\n# 見出し 2\n\n段落 C\n'

function load(markdown = DOC): void {
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

interface DecoLike { from: number; to: number; type: { attrs?: Record<string, string> } }
function decorationsWith(className: string): string[] {
  const out: string[] = []
  for (const plugin of view.state.plugins) {
    const set = plugin.props.decorations?.call(plugin, view.state) as { find?: () => DecoLike[] } | undefined
    if (set?.find === undefined) continue
    for (const deco of set.find()) {
      if ((deco.type.attrs?.['class'] ?? '') === className) out.push(view.state.doc.textBetween(deco.from, deco.to, ' '))
    }
  }
  return out
}

const sections = (): ReturnType<typeof sectionsOf> => sectionsOf(view.state, foldedHeadings(view.state))
const posOf = (text: string): number => {
  const found = sections().find((s) => s.text === text)
  if (found === undefined) throw new Error(`見出しが無い: ${text}`)
  return found.pos
}

describe('節の組み立て', () => {
  it('見出しを階層つきで拾う', () => {
    load()
    expect(sections().map((s) => [s.text, s.level])).toEqual([
      ['見出し 1', 1], ['見出し 1-1', 2], ['見出し 2', 1],
    ])
  })

  it('中身が無い見出しは畳めない', () => {
    load('# 空\n\n# 中身あり\n\n段落\n')
    expect(sections().map((s) => s.foldable)).toEqual([false, true])
  })
})

describe('折りたたみ', () => {
  it('次の同じか上位の見出しまでを隠す', () => {
    load()
    toggleHeadingFoldAt(view, posOf('見出し 1'))
    expect(decorationsWith('is-folded-away')).toEqual(['段落 A', '見出し 1-1', '段落 B'])
  })

  it('下位の見出しを畳んでも、上位の兄弟は隠れない', () => {
    load()
    toggleHeadingFoldAt(view, posOf('見出し 1-1'))
    expect(decorationsWith('is-folded-away')).toEqual(['段落 B'])
  })

  it('畳んだ節の中の見出しは目次からも隠れる (画面と一致させる)', () => {
    load()
    toggleHeadingFoldAt(view, posOf('見出し 1'))
    expect(sections().filter((s) => !s.hidden).map((s) => s.text)).toEqual(['見出し 1', '見出し 2'])
  })

  it('もう一度で開く', () => {
    load()
    const pos = posOf('見出し 1')
    toggleHeadingFoldAt(view, pos)
    toggleHeadingFoldAt(view, pos)
    expect(decorationsWith('is-folded-away')).toEqual([])
  })

  it('畳んでも Markdown は 1 バイトも動かない (不変条件 1)', () => {
    load()
    toggleHeadingFoldAt(view, posOf('見出し 1'))
    expect(save()).toBe(DOC)
  })

  it('編集で位置がずれても畳んだ節は追従する', () => {
    load()
    toggleHeadingFoldAt(view, posOf('見出し 1-1'))
    // 先頭に文字を挿入して全体を後ろへずらす
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(1))).insertText('X'))
    expect(decorationsWith('is-folded-away')).toEqual(['段落 B'])
  })
})
