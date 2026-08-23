/**
 * コードフェンスの色付け (task #14)。
 * **保存される Markdown が動かないこと**と、字句が拾えることの両方を固定する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { code, grammarFor, tokenize } from '../code'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => { ctx.set(rootCtx, host); applyLoamiumStringifyOptions(ctx) })
    .use(commonmark).use(gfm).use(code)
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
function tokens(): { text: string; type: string }[] {
  const out: { text: string; type: string }[] = []
  for (const plugin of view.state.plugins) {
    const set = plugin.props.decorations?.call(plugin, view.state) as { find?: () => DecoLike[] } | undefined
    if (set?.find === undefined) continue
    for (const deco of set.find()) {
      const cls = deco.type.attrs?.['class'] ?? ''
      if (!cls.startsWith('tok ')) continue
      out.push({ text: view.state.doc.textBetween(deco.from, deco.to), type: cls.replace('tok tok-', '') })
    }
  }
  return out
}

describe('言語の解決', () => {
  it('別名を吸収する', () => {
    expect(grammarFor('ts')).not.toBeNull()
    expect(grammarFor('sh')).not.toBeNull()
    expect(grammarFor('yml')).not.toBeNull()
  })

  it('知らない言語は色を付けない', () => {
    expect(grammarFor('brainfuck')).toBeNull()
    expect(tokenize('x', 'brainfuck')).toEqual([])
  })
})

describe('字句の位置', () => {
  it('位置がコード内のオフセットと合う', () => {
    const src = 'const a = 1'
    for (const token of tokenize(src, 'ts')) {
      expect(src.slice(token.start, token.end).length).toBe(token.end - token.start)
    }
  })

  it('キーワードと文字列を見分ける', () => {
    const found = tokenize('const a = "x"', 'ts')
    expect(found.some((t) => t.type === 'keyword')).toBe(true)
    expect(found.some((t) => t.type === 'string')).toBe(true)
  })
})

describe('エディタの中', () => {
  it('コードフェンスに色が付く', () => {
    load('```ts\nconst a = 1\n```\n')
    const found = tokens()
    expect(found.some((t) => t.type === 'keyword' && t.text === 'const')).toBe(true)
  })

  it('言語の指定が無ければ色を付けない', () => {
    load('```\nconst a = 1\n```\n')
    expect(tokens()).toEqual([])
  })

  it('保存される Markdown は動かない', () => {
    const body = '```ts\nconst a: number = 1\n```\n'
    load(body)
    expect(save()).toBe(body)
  })
})
