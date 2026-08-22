/**
 * WikiLink (task #4) を Milkdown 実体に対して検証する。
 *
 * いちばん大事なのは **`[[…]]` がテキストのままであること**。スキーマにノードを足していないので
 * serializer は素通しのはずで、それを round-trip で固定する (不変条件 1・2)。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { exitNodeKeymap } from '@loamium/ui/src/editor/exit-node'
import { outline } from '../../outline/outline'
import { wikilink, suggestNotes, suggestStateOf, accept } from '../wikilink'
import { resetEditorEnv, setEditorEnv } from '@loamium/ui/src/editor/editor-env'

const NOTES = ['index.md', 'プロジェクト/計画.md', 'プロジェクト/メモ.md', 'アーカイブ/メモ.md']

let editor: Editor
let view: EditorView
let host: HTMLElement
const opened: string[] = []
const created: string[] = []

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host)
      applyLoamiumStringifyOptions(ctx)
    })
    .use(wikilink).use(commonmark).use(gfm).use(exitNodeKeymap).use(outline)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove(); resetEditorEnv() })

beforeEach(() => {
  opened.length = 0
  created.length = 0
  setEditorEnv({
    notes: NOTES,
    tags: [],
    currentPath: 'index.md',
    open: (path: string) => opened.push(path),
    create: (target: string) => created.push(target),
    openTag: () => {},
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

/** いま貼られている wikilink decoration を読み出す */
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

function decorations(): { text: string; broken: boolean }[] {
  return allDecorations()
    .filter((deco) => (deco.type.attrs?.['class'] ?? '').startsWith('wikilink '.trim()))
    .filter((deco) => !(deco.type.attrs?.['class'] ?? '').includes('wikilink-syntax'))
    .map((deco) => ({
      text: view.state.doc.textBetween(deco.from, deco.to),
      broken: (deco.type.attrs?.['class'] ?? '').includes('is-broken'),
    }))
}

describe('表示', () => {
  it('解決できるリンクと壊れリンクを見分ける', () => {
    load('[[計画]] と [[存在しない]]\n')
    expect(decorations()).toEqual([
      { text: '[[計画]]', broken: false },
      { text: '[[存在しない]]', broken: true },
    ])
  })

  it('見出し・表示名つきでも解決する', () => {
    load('[[計画#今週|やること]]\n')
    expect(decorations()).toEqual([{ text: '[[計画#今週|やること]]', broken: false }])
  })

  it('同名ノートはリンク元と同じフォルダを優先する', () => {
    setEditorEnv({
      notes: NOTES, tags: [], currentPath: 'アーカイブ/古い.md',
      open: () => {}, create: () => {}, openTag: () => {},
    })
    load('[[メモ]]\n')
    expect(decorations()).toEqual([{ text: '[[メモ]]', broken: false }])
  })

  it('コードフェンスの中はリンクにしない', () => {
    load('```md\n[[計画]]\n```\n')
    expect(decorations()).toEqual([])
  })

  it('インラインコードの中もリンクにしない', () => {
    load('`[[計画]]` と [[計画]]\n')
    expect(decorations()).toHaveLength(1)
  })
})

/** 隠している記法の範囲 */
function hidden(): string[] {
  return allDecorations()
    .filter((deco) => (deco.type.attrs?.['class'] ?? '') === 'wikilink-syntax')
    .map((deco) => view.state.doc.textBetween(deco.from, deco.to))
}

describe('記法の見せ方', () => {
  it('普段は [[ ]] を隠す', () => {
    load('[[計画]] を見る\n')
    expect(hidden()).toEqual(['[[', ']]'])
  })

  it('表示名があるときはリンク先ごと隠して表示名だけ見せる', () => {
    load('まず [[プロジェクト/計画#今週|やること]] を見る\n')
    expect(hidden()).toEqual(['[[', 'プロジェクト/計画#今週|', ']]'])
  })

  it('カーソルが触れているリンクは素の Markdown を出す', () => {
    load('[[計画]] を見る\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(4))))
    expect(hidden()).toEqual([])
  })

  it('別の場所にカーソルがあるリンクは隠れたまま', () => {
    load('[[計画]] と [[存在しない]]\n')
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(4))))
    expect(hidden()).toEqual(['[[', ']]'])
  })
})

describe('保存', () => {
  it('[[…]] はテキストのまま。開いて保存しても 1 バイトも動かない', () => {
    const body = '# メモ\n\n- [[計画]] を見る\n- [[プロジェクト/メモ#今日|別名]]\n- [[まだ無い]]\n'
    load(body)
    expect(save()).toBe(body)
  })
})

describe('補完候補', () => {
  it('ノート名の前方一致を上に出す', () => {
    expect(suggestNotes('メ', NOTES)).toEqual(['アーカイブ/メモ.md', 'プロジェクト/メモ.md'])
  })

  it('パスでも引ける', () => {
    expect(suggestNotes('プロジェクト', NOTES)).toEqual(['プロジェクト/メモ.md', 'プロジェクト/計画.md'])
  })

  it('空なら全部 (打ち始める前でも一覧が出る)', () => {
    expect(suggestNotes('', NOTES)).toHaveLength(NOTES.length)
  })

  it('一致しなければ空 (= 候補は出ない)', () => {
    expect(suggestNotes('zzz', NOTES)).toEqual([])
  })
})

describe('[[ の補完', () => {
  /** 空の段落に文字を打つ */
  function type(text: string): void {
    load('\n')
    const end = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end))))
    for (const char of text) view.dispatch(view.state.tr.insertText(char))
  }

  it('[[ を打つと候補が出る', () => {
    type('[[')
    expect(suggestStateOf(view.state)?.items.map((item) => item.value))
      .toEqual([...NOTES].sort((a, b) => a.localeCompare(b, 'ja')))
  })

  it('打った文字で絞り込まれる', () => {
    type('[[計')
    expect(suggestStateOf(view.state)?.items.map((item) => item.value)).toEqual(['プロジェクト/計画.md'])
  })

  it('すでに閉じているリンクの中では候補を出さない (カーソルを置いただけで開かない)', () => {
    load('[[計画]] を見る\n')
    // `[[` の直後にカーソルを置く
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(3))))
    expect(suggestStateOf(view.state)).toBeNull()
  })

  it('] を閉じたら候補は消える', () => {
    type('[[計画]]')
    expect(suggestStateOf(view.state)).toBeNull()
  })

  it('確定するとノート名が入って [[…]] が閉じる', () => {
    type('[[計')
    accept(view, 'プロジェクト/計画.md')
    expect(save()).toBe('[[計画]]\n')
  })

  it('同名ノートはフォルダ付きで確定する (解決できない書き方にしない)', () => {
    type('[[メ')
    accept(view, 'プロジェクト/メモ.md')
    expect(save()).toBe('[[プロジェクト/メモ]]\n')
  })

  it('リストの中でも確定できる (Enter がリスト分割に食われない)', () => {
    load('- \n')
    const end = view.state.doc.content.size - 2
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end))))
    for (const char of '[[計') view.dispatch(view.state.tr.insertText(char))
    const active = suggestStateOf(view.state)
    expect(active?.items.map((item) => item.value)).toEqual(['プロジェクト/計画.md'])
    const handled = view.someProp('handleKeyDown', (f) =>
      f(view, new KeyboardEvent('keydown', { key: 'Enter' })))
    expect(handled).toBe(true)
    expect(save()).toBe('- [[計画]]\n')
  })
})

describe('クリック', () => {
  it('解決できるリンクは開く / 壊れリンクは作成へ回す', () => {
    load('[[計画]] と [[まだ無い]]\n')
    const span = (attrs: Record<string, string>): HTMLElement => {
      const el = document.createElement('span')
      el.className = 'wikilink'
      Object.assign(el.dataset, attrs)
      return el
    }
    /** handleClick はイベントの target を見る。jsdom の MouseEvent は target を持てないので差し込む */
    const fire = (el: HTMLElement): void => {
      const event = new MouseEvent('click')
      Object.defineProperty(event, 'target', { value: el })
      view.someProp('handleClick', (f) => f(view, 1, event))
    }
    fire(span({ path: 'プロジェクト/計画.md', target: '計画' }))
    fire(span({ target: 'まだ無い' }))
    expect(opened).toEqual(['プロジェクト/計画.md'])
    expect(created).toEqual(['まだ無い'])
  })
})
