/** タグ (task #9) を Milkdown 実体に対して検証する */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { tag, tagSuggest, tagSuggestStateOf, suggestTags } from '../tag'
import { wikilink } from '../../links/wikilink'
import { resetEditorEnv, setEditorEnv } from '@loamium/ui/src/editor/editor-env'

const TAGS = ['仕事', '読書', '読書/SF']

let editor: Editor
let view: EditorView
let host: HTMLElement
const openedTags: string[] = []

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host)
      applyLoamiumStringifyOptions(ctx)
    })
    .use(wikilink).use(tag).use(commonmark).use(gfm)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove(); resetEditorEnv() })

beforeEach(() => {
  openedTags.length = 0
  setEditorEnv({
    notes: [], tags: TAGS, currentPath: 'index.md',
    open: () => {}, create: () => {}, openTag: (t: string) => openedTags.push(t),
  })
})

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

interface DecoLike { from: number; to: number; type: { attrs?: Record<string, string> } }

/**
 * すべてのプラグインの decoration を集める。
 * ⚠️ `someProp('decorations')` は**最初に見つかった 1 つ**しか返さない
 * (ProseMirror 本体は全プラグイン分を集めるので、テスト側だけの話)。
 */
function allDecorations(): DecoLike[] {
  const out: DecoLike[] = []
  for (const plugin of view.state.plugins) {
    const set = plugin.props.decorations?.call(plugin, view.state) as { find?: () => DecoLike[] } | undefined
    if (set?.find !== undefined) out.push(...set.find())
  }
  return out
}

function tagDecorations(): string[] {
  return allDecorations()
    .filter((deco) => (deco.type.attrs?.['class'] ?? '') === 'tag-chip')
    .map((deco) => view.state.doc.textBetween(deco.from, deco.to))
}

describe('表示', () => {
  it('本文中の #タグ を見つける', () => {
    load('今日は #仕事 と #読書/SF\n')
    expect(tagDecorations()).toEqual(['#仕事', '#読書/SF'])
  })

  it('見出しはタグにしない', () => {
    load('# 見出し\n\n## 小見出し\n')
    expect(tagDecorations()).toEqual([])
  })

  it('コードの中はタグにしない', () => {
    load('`#コード` と #本物\n')
    expect(tagDecorations()).toEqual(['#本物'])
  })

  it('タグはテキストのまま。保存しても動かない', () => {
    const body = '#仕事 のメモ\n'
    load(body)
    expect(save()).toBe(body)
  })
})

describe('クリック', () => {
  it('タグをクリックすると絞り込みへ回す', () => {
    load('#仕事\n')
    const el = document.createElement('span')
    el.className = 'tag-chip'
    el.dataset['tag'] = '仕事'
    const event = new MouseEvent('click')
    Object.defineProperty(event, 'target', { value: el })
    view.someProp('handleClick', (f) => f(view, 1, event))
    expect(openedTags).toEqual(['仕事'])
  })
})

describe('候補', () => {
  it('前方一致を上に出す', () => {
    expect(suggestTags('読', TAGS)).toEqual(['読書', '読書/SF'])
  })

  it('一致しなければ空', () => {
    expect(suggestTags('zzz', TAGS)).toEqual([])
  })
})

describe('# の補完', () => {
  function type(text: string): void {
    load('\n')
    const end = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end))))
    for (const char of text) view.dispatch(view.state.tr.insertText(char))
  }

  it('# を打つと候補が出る', () => {
    type('メモ #')
    expect(tagSuggestStateOf(view.state)?.items.map((item) => item.value)).toEqual(['仕事', '読書', '読書/SF'])
  })

  it('打った文字で絞り込まれる', () => {
    type('メモ #読')
    expect(tagSuggestStateOf(view.state)?.items.map((item) => item.value)).toEqual(['読書', '読書/SF'])
  })

  it('確定するとタグが入る', () => {
    type('メモ #読')
    const active = tagSuggestStateOf(view.state)
    const item = active?.items[1]
    if (item === undefined) throw new Error('候補が無い')
    tagSuggest.accept(view, item)
    expect(save()).toBe('メモ #読書/SF\n')
  })

  it('空白のあとの # だけが対象 (URL の # では出ない)', () => {
    type('https://example.com/#')
    expect(tagSuggestStateOf(view.state)).toBeNull()
  })
})
