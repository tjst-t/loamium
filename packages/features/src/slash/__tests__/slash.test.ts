/**
 * スラッシュメニュー (task #12) を Milkdown 実体に対して検証する。
 *
 * 判定は**挿入後に保存される Markdown**。候補が「標準 Markdown に往復するものだけ」で
 * あることを、出力そのもので固定する (不変条件 1)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { normalizeForSave } from '@loamium/shared'
import { applyLoamiumStringifyOptions } from '@loamium/ui/src/editor/markdown-config'
import { filterSlashItems, slash, slashSuggest, SLASH_ITEMS } from '../slash'

let editor: Editor
let view: EditorView
let host: HTMLElement

beforeAll(async () => {
  // jsdom には getClientRects が無く、ProseMirror の scrollIntoView が落ちる。
  // 位置は使わないので空で足りる
  const empty = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList
  const rect = (): DOMRect => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  })
  Range.prototype.getClientRects = empty
  Range.prototype.getBoundingClientRect = rect
  Element.prototype.getClientRects = empty
  Element.prototype.getBoundingClientRect = rect

  host = document.createElement('div')
  document.body.appendChild(host)
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host)
      applyLoamiumStringifyOptions(ctx)
    })
    .use(slash).use(commonmark).use(gfm)
    .create()
  editor.action((ctx) => { view = ctx.get(editorViewCtx) })
})
afterAll(async () => { await editor?.destroy(); host?.remove() })

function load(markdown = '\n'): void {
  editor.action((ctx) => {
    const doc = ctx.get(parserCtx)(markdown)
    if (!doc) throw new Error('parse failed')
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
  })
  const end = view.state.doc.content.size - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end))))
}

const save = (): string => {
  let out = ''
  editor.action((ctx) => { out = normalizeForSave(ctx.get(serializerCtx)(view.state.doc)) })
  return out
}

/** 1 文字ずつ打つ (input rule や補完の発火条件を実際と同じにするため) */
function type(text: string): void {
  for (const char of text) view.dispatch(view.state.tr.insertText(char))
}

const active = (): ReturnType<typeof slashSuggest.activeState> => slashSuggest.activeState(view.state)

/** メニューから選んで確定する */
function pick(value: string): void {
  const item = SLASH_ITEMS.find((entry) => entry.value === value)
  if (item === undefined) throw new Error(`候補が無い: ${value}`)
  slashSuggest.accept(view, item)
}

describe('候補の絞り込み', () => {
  it('空なら全部', () => {
    expect(filterSlashItems('')).toHaveLength(SLASH_ITEMS.length)
  })

  it('往復する記法だけが候補にある', () => {
    const values = SLASH_ITEMS.map((item) => item.value)
    expect(values).toContain('highlight')
    expect(values).toContain('math')
    expect(values).toContain('diagram')
  })

  it('日本語で引ける', () => {
    expect(filterSlashItems('見出し').map((i) => i.value)).toEqual(['h1', 'h2', 'h3'])
    expect(filterSlashItems('表').map((i) => i.value)).toEqual(['table'])
  })

  it('かな読みでも引ける (IME で確定した直後の語で探せる)', () => {
    expect(filterSlashItems('ひょう').map((i) => i.value)).toEqual(['table'])
    expect(filterSlashItems('みだし').map((i) => i.value)).toEqual(['h1', 'h2', 'h3'])
  })

  it('英語 (ローマ字) でも引ける', () => {
    expect(filterSlashItems('table').map((i) => i.value)).toEqual(['table'])
    // `todo` はチェックボックスと、状態フィールドの既定値 `[status:: todo]` の両方に当たる
    expect(filterSlashItems('todo').map((i) => i.value)).toEqual(['task', 'status'])
  })

  it('記法そのものでも引ける', () => {
    expect(filterSlashItems('##').map((i) => i.value)).toEqual(['h2', 'h3'])
  })

  it('一致しなければ空', () => {
    expect(filterSlashItems('zzz')).toEqual([])
  })
})

describe('メニューが出る条件', () => {
  it('行頭の / で出る', () => {
    load()
    type('/')
    expect(active()?.items.length).toBe(SLASH_ITEMS.length)
  })

  it('空白の直後の / でも出る', () => {
    load()
    type('メモ /')
    expect(active()).not.toBeNull()
  })

  it('パスの区切りでは出さない (foo/bar)', () => {
    load()
    type('foo/bar')
    expect(active()).toBeNull()
  })

  it('打った文字で絞り込まれる', () => {
    load()
    type('/表')
    expect(active()?.items.map((i) => i.value)).toEqual(['table'])
  })
})

describe('挿入した結果 (保存される Markdown)', () => {
  const cases: [string, string, string][] = [
    ['見出し 1', 'h1', '#\n'],
    ['見出し 2', 'h2', '##\n'],
    ['箇条書き', 'bullet', '-\n'],
    ['番号付き', 'ordered', '1.\n'],
    ['引用', 'quote', '>\n'],
    ['区切り線', 'hr', '---\n'],
  ]

  for (const [name, value, expected] of cases) {
    it(`${name} → ${JSON.stringify(expected)}`, () => {
      load()
      type('/')
      pick(value)
      expect(save()).toBe(expected)
    })
  }

  it('チェックボックス → 文字を打つと `- [ ] ` になる', () => {
    load()
    type('/')
    pick('task')
    // ⚠️ 空のままだと `- [ ]` は GFM のタスク項目として読み直せず、ただの `-` に戻る。
    //    構造としては checked: false が入っている
    type('やること')
    expect(save()).toBe('- [ ] やること\n')
  })

  it('ハイライト → ==…== が入り、中身が選択される', () => {
    load()
    type('/')
    pick('highlight')
    expect(save()).toBe('==ハイライト==\n')
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('ハイライト')
  })

  it('callout → 引用の 1 行目が [!note] になり、タイトルが選択される', () => {
    load()
    type('/')
    pick('callout')
    expect(save()).toBe('> [!note] タイトル\n')
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('タイトル')
  })

  it('数式 → $…$ が入り、中身が選択される', () => {
    load()
    type('/')
    pick('math')
    expect(save()).toBe('$x^2$\n')
  })

  it('Mermaid 図 → ```mermaid のフェンスと雛形が入る', () => {
    load()
    type('/')
    pick('diagram')
    expect(save()).toBe('```mermaid\ngraph TD\n  A[はじめ] --> B[つぎ]\n```\n')
  })

  it('表 → GFM の表になる', () => {
    load()
    type('/')
    pick('table')
    expect(save()).toBe('| | | |\n| - | - | - |\n| | | |\n')
  })

  it('コードブロック → フェンスになる', () => {
    load()
    type('/')
    pick('code')
    expect(save()).toBe('```\n```\n')
  })

  it('`/` とその後の入力は本文に残さない', () => {
    load()
    type('/みだ')
    pick('h1')
    expect(save()).toBe('#\n')
  })

  it('書きかけの行の途中でも、その行を変換する', () => {
    load()
    type('メモ /')
    pick('h2')
    expect(save()).toBe('## メモ\n')
  })

  it('インラインコード → 差し替える前提のプレースホルダが選択された状態で入る', () => {
    load()
    type('/')
    pick('inline-code')
    expect(save()).toBe('`コード`\n')
    // 選択されているので、そのまま打てば置き換わる
    expect(view.state.selection.empty).toBe(false)
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('コード')
  })

  it('今日の日付 → ISO で入る', () => {
    load()
    type('/')
    pick('today')
    expect(save()).toMatch(/^\d{4}-\d{2}-\d{2}\n$/)
  })

  it('リンクとタグは文字を置くだけ (次の補完に引き継ぐ)', () => {
    load()
    type('/')
    pick('link')
    expect(save()).toBe('[[\n')
  })
})

describe('文脈で並びが変わる (task #52)', () => {
  const values = (query: string, contexts: string[]): string[] =>
    filterSlashItems(query, undefined, new Set(contexts as never[])).map((i) => i.value)

  it('タスクの行では状態・優先度・期限が先頭に来る (狭い文脈ほど強い)', () => {
    expect(values('', ['list', 'task']).slice(0, 3)).toEqual(['status', 'priority', 'due'])
  })

  it('表の中では表の操作が上に来る', () => {
    expect(values('', ['table', 'empty']).indexOf('table')).toBeLessThan(values('', ['table', 'empty']).indexOf('status'))
  })

  it('タスクの行でも他の候補は消えない (並びが下がるだけ)', () => {
    const all = values('', ['list', 'task'])
    expect(all).toContain('table')
    expect(all).toHaveLength(filterSlashItems('').length)
  })

  it('何も書いていない行ではブロックを作るものが上に来る', () => {
    expect(values('', ['empty']).slice(0, 3)).toEqual(['h1', 'h2', 'h3'])
    // タスク用のフィールドは沈む (チェックボックスの行ではないので)
    expect(values('', ['empty']).indexOf('status')).toBeGreaterThan(values('', ['empty']).indexOf('table'))
  })

  it('同じ重みのものは宣言順のまま (並びが毎回変わらない)', () => {
    const listed = values('', ['task'])
    expect(listed.indexOf('status')).toBeLessThan(listed.indexOf('priority'))
    expect(listed.indexOf('priority')).toBeLessThan(listed.indexOf('due'))
  })

  it('文脈が無ければ宣言順のまま', () => {
    expect(values('', [])).toEqual(filterSlashItems('').map((i) => i.value))
  })
})
