/**
 * アウトライン操作 (task #10) の受け入れ条件。
 *
 * 検証はすべて **Milkdown 実体** に対して行う (mock ではエディタの挙動を保証できない)。
 * 判定は「Markdown へ書き戻した結果」で行う — 不変条件 1 より、UI の状態ではなく
 * ファイルに落ちる文字列が正しいことが唯一意味を持つため。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Command } from '@milkdown/kit/prose/state'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { exitNodeKeymap } from '@loamium/ui/src/editor/exit-node'
import { outline, setListKind, toggleFold, toggleTaskChecked, foldKey } from '../outline'

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
    .use(commonmark)
    .use(gfm)
    .use(exitNodeKeymap)
    .use(outline)
    .create()
  editor.action((ctx) => {
    view = ctx.get(editorViewCtx)
  })
})
afterAll(async () => {
  await editor?.destroy()
  host?.remove()
})

/** Markdown を読み込んでカーソルを置く。cursorAt = ドキュメント内の行番号 (0 始まり) */
function load(markdown: string, line = 0): void {
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(markdown)
    if (!doc) throw new Error('parse failed')
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
    view.dispatch(tr)
  })
  // 行番号 = 先頭から数えた textblock の順番
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) positions.push(pos + 1)
    return true
  })
  const target = positions[line]
  if (target === undefined) throw new Error(`no textblock at line ${line}`)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
}

function selectLines(from: number, to: number): void {
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) positions.push(pos + 1)
    return true
  })
  const a = positions[from]
  const b = positions[to]
  if (a === undefined || b === undefined) throw new Error('bad range')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, b)))
}

function run(command: Command): boolean {
  return command(view.state, view.dispatch.bind(view), view)
}

/** 実際の保存経路と同じ: serializer → normalizeForSave */
function save(): string {
  let out = ''
  editor.action((ctx) => {
    out = normalizeForSave(ctx.get(serializerCtx)(view.state.doc))
  })
  return out
}

/** キーボードから来る Tab / Shift-Tab を再現する */
function pressTab(shift = false): boolean {
  return view.someProp('handleKeyDown', (f) =>
    f(view, new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift })),
  ) ?? false
}

describe('Tab / Shift-Tab によるインデント', () => {
  it('リスト項目を Tab で子にできる', () => {
    load('- a\n- b\n', 1)
    expect(pressTab()).toBe(true)
    expect(save()).toBe('- a\n  - b\n')
  })

  it('Shift-Tab で親へ戻せる (子要素も追従する)', () => {
    load('- a\n  - b\n    - c\n', 1)
    expect(pressTab(true)).toBe(true)
    expect(save()).toBe('- a\n- b\n  - c\n')
  })

  it('複数行を選択して一括インデントできる', () => {
    load('- a\n- b\n- c\n')
    selectLines(1, 2)
    expect(pressTab()).toBe(true)
    expect(save()).toBe('- a\n  - b\n  - c\n')
  })

  it('先頭項目は Tab で沈まない (親が無い)', () => {
    load('- a\n- b\n', 0)
    expect(pressTab()).toBe(false)
    expect(save()).toBe('- a\n- b\n')
  })

  it('リストの外の Tab は握り潰す (フォーカスがエディタから飛ばない)', () => {
    load('ふつうの段落\n')
    expect(pressTab()).toBe(true)
    expect(save()).toBe('ふつうの段落\n')
  })
})

describe('番号リストの採番', () => {
  it('インデントしても番号が振り直される', () => {
    load('1. a\n2. b\n3. c\n', 1)
    expect(pressTab()).toBe(true)
    expect(save()).toBe('1. a\n   1. b\n2. c\n')
  })
})

describe('リスト種別の変換', () => {
  it('箇条書き → 番号', () => {
    load('- a\n- b\n', 0)
    expect(run(setListKind('ordered'))).toBe(true)
    expect(save()).toBe('1. a\n2. b\n')
  })

  it('番号 → 箇条書き', () => {
    load('1. a\n2. b\n', 0)
    expect(run(setListKind('bullet'))).toBe(true)
    expect(save()).toBe('- a\n- b\n')
  })

  it('箇条書き → チェックボックス', () => {
    load('- a\n- b\n', 0)
    expect(run(setListKind('task'))).toBe(true)
    expect(save()).toBe('- [ ] a\n- [ ] b\n')
  })

  it('チェックボックス → 箇条書き (checked が落ちる)', () => {
    load('- [x] a\n- [ ] b\n', 0)
    expect(run(setListKind('bullet'))).toBe(true)
    expect(save()).toBe('- a\n- b\n')
  })

  it('リストの外なら段落をリストに包む', () => {
    load('ふつうの段落\n')
    expect(run(setListKind('bullet'))).toBe(true)
    expect(save()).toBe('- ふつうの段落\n')
  })

  it('完了/未完了を切り替えられる', () => {
    load('- [ ] a\n', 0)
    expect(run(toggleTaskChecked)).toBe(true)
    expect(save()).toBe('- [x] a\n')
  })

  it('チェックボックスでない項目では切り替えない', () => {
    load('- a\n', 0)
    expect(run(toggleTaskChecked)).toBe(false)
  })
})

describe('折りたたみ', () => {
  it('子を持つ項目は折りたためる', () => {
    load('- a\n  - b\n', 0)
    expect(run(toggleFold)).toBe(true)
    expect(foldKey.getState(view.state)?.find().length).toBe(1)
  })

  it('子を持たない項目は折りたためない', () => {
    load('- a\n- b\n', 1)
    expect(run(toggleFold)).toBe(false)
  })

  it('折りたたんでも Markdown には一切書き込まない (不変条件 1)', () => {
    load('- a\n  - b\n', 0)
    run(toggleFold)
    expect(save()).toBe('- a\n  - b\n')
  })

  it('もう一度呼ぶと展開する', () => {
    load('- a\n  - b\n', 0)
    run(toggleFold)
    run(toggleFold)
    expect(foldKey.getState(view.state)?.find().length).toBe(0)
  })
})
