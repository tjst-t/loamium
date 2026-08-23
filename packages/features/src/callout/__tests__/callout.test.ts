/**
 * callout とハイライト (task #13)。
 *
 * **スキーマも serializer も触らない**ことが要。判定は「保存した Markdown が動かないこと」と
 * 「decoration が付くこと」の両方で行う。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { callout, parseCalloutHead } from '../callout'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(callout)
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

interface DecoLike { from: number; to: number; type: { attrs?: Record<string, string> } }
function classes(): string[] {
  const out: string[] = []
  for (const plugin of view.state.plugins) {
    const set = plugin.props.decorations?.call(plugin, view.state) as { find?: () => DecoLike[] } | undefined
    if (set?.find === undefined) continue
    for (const deco of set.find()) {
      const cls = deco.type.attrs?.['class']
      if (cls !== undefined) out.push(cls)
    }
  }
  return out
}

describe('見出し行の解析', () => {
  it('種別とタイトルを取り出す', () => {
    expect(parseCalloutHead('[!note] メモ')).toMatchObject({ type: 'note', title: 'メモ' })
    expect(parseCalloutHead('[!WARNING]')).toMatchObject({ type: 'warning', title: '' })
  })

  it('知らない種別は callout にしない', () => {
    expect(parseCalloutHead('[!unknown] x')).toBeNull()
    expect(parseCalloutHead('ふつうの引用')).toBeNull()
  })
})

describe('callout', () => {
  it('引用に種別の印を付ける', () => {
    load('> [!warning] 気をつける\n> 本文\n')
    expect(classes()).toContain('callout callout-warning')
  })

  it('ふつうの引用には付けない', () => {
    load('> ただの引用\n')
    expect(classes().some((cls) => cls.startsWith('callout'))).toBe(false)
  })

  it('保存しても Markdown は動かない', () => {
    const body = '> [!tip] ヒント\n> 中身\n'
    load(body)
    expect(save()).toBe(body)
  })
})

describe('ハイライト', () => {
  it('==…== に印を付ける', () => {
    load('これは ==大事== です\n')
    expect(classes()).toContain('highlight')
  })

  it('普段は == を隠し、カーソルが触れたら出す', () => {
    load('これは ==大事== です\n')
    expect(classes().filter((cls) => cls === 'highlight-syntax')).toHaveLength(2)
    // ハイライトの中へカーソルを移す
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(8))))
    expect(classes().filter((cls) => cls === 'highlight-syntax')).toHaveLength(0)
  })

  it('コードの中は対象外', () => {
    load('`==コード==`\n')
    expect(classes()).not.toContain('highlight')
  })

  it('保存しても Markdown は動かない (行頭でも backslash が付かない)', () => {
    const body = '==強調==\n\nこれは ==大事== です\n'
    load(body)
    expect(save()).toBe(body)
  })
})
