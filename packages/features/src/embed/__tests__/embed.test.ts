/**
 * 埋め込み `![[…]]` (task #13)。
 *
 * 大事なのは **本文の文字列が変わらないこと**。カードは decoration なので、
 * 保存される Markdown は `![[…]]` のまま。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave, parseWikiLinks } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { setEditorEnv, resetEditorEnv } from '@loamium/ui/src/editor/editor-env'
import { embed, primeEmbed } from '../embed'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  setEditorEnv({
    notes: ['メモ.md'], tags: [], currentPath: 'index.md',
    open: () => {}, create: () => {}, openTag: () => {},
  })
  primeEmbed('index.md', 'メモ', { path: 'メモ.md', heading: null, excerpt: '中身です', truncated: false })
  primeEmbed('index.md', 'メモ#目的', { path: 'メモ.md', heading: '目的', excerpt: '目的の中身', truncated: false })
  primeEmbed('index.md', '無いノート', { path: null, heading: null, excerpt: '', truncated: false })
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(embed)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove(); resetEditorEnv() })

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

interface DecoLike { from: number; to: number; type: { attrs?: Record<string, string>; toDOM?: unknown } }
function decorations(): DecoLike[] {
  const out: DecoLike[] = []
  for (const plugin of view.state.plugins) {
    const set = plugin.props.decorations?.call(plugin, view.state) as { find?: () => DecoLike[] } | undefined
    if (set?.find !== undefined) out.push(...set.find())
  }
  return out
}

const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.embed-card')]

describe('解析 (shared)', () => {
  it('`![[…]]` は埋め込みとして拾う', () => {
    const [link] = parseWikiLinks('![[メモ]]')
    expect(link).toMatchObject({ embed: true, target: 'メモ', raw: '![[メモ]]' })
  })

  it('`[[…]]` は埋め込みではない', () => {
    expect(parseWikiLinks('[[メモ]]')[0]?.embed).toBe(false)
  })
})

describe('表示', () => {
  it('中身のカードが出る', () => {
    load('![[メモ]]\n')
    expect(cards()).toHaveLength(1)
    expect(cards()[0]?.textContent).toContain('中身です')
  })

  it('見出しを指すとその節が出る', () => {
    load('![[メモ#目的]]\n')
    expect(cards()[0]?.textContent).toContain('目的の中身')
  })

  it('無いノートは壊れリンクとして出す', () => {
    load('![[無いノート]]\n')
    expect(cards()[0]?.className).toContain('is-broken')
  })

  it('記法は普段隠し、カーソルが中に入ったら出す', () => {
    load('![[メモ]]\n')
    const hidden = (): number => decorations().filter((d) => d.type.attrs?.['class'] === 'embed-syntax').length
    expect(hidden()).toBe(1)
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(3))))
    expect(hidden()).toBe(0)
  })

  it('コードの中は埋め込みにしない', () => {
    load('```\n![[メモ]]\n```\n')
    expect(cards()).toHaveLength(0)
  })
})

describe('保存', () => {
  it('本文は `![[…]]` のまま動かない', () => {
    const body = '参照: ![[メモ#目的]] です\n'
    load(body)
    expect(save()).toBe(body)
  })
})
