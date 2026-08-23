import { $prose } from '@milkdown/kit/utils'
import { TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import { wrapInList } from '@milkdown/kit/prose/schema-list'
import type { NodeType } from '@milkdown/kit/prose/model'
import { createSuggest, type SuggestItem } from '@loamium/ui/src/editor/suggest'

/**
 * スラッシュメニュー (task #12)。
 *
 * `/` を打つと挿入候補が出る。**入るのは標準 Markdown に往復できるものだけ** —
 * スキーマが Markdown 表現力の型なので、ここに独自ブロックを足さない (ADR-0035)。
 *
 * ⚠️ 補完は Enter / Tab をリストのコマンドより先に拾う必要があるので、
 * preset より**前**に use すること。
 */

const type = (state: EditorState, name: string): NodeType | undefined => state.schema.nodes[name]

/** その場のブロックを差し替える */
function toBlock(name: string, attrs?: Record<string, unknown>): Command {
  return (state, dispatch, view) => {
    const nodeType = type(state, name)
    if (nodeType === undefined) return false
    return setBlockType(nodeType, attrs)(state, dispatch, view)
  }
}

function toList(name: 'bullet_list' | 'ordered_list', task = false): Command {
  return (state, dispatch, view) => {
    const listType = type(state, name)
    const itemType = type(state, 'list_item')
    if (listType === undefined || itemType === undefined) return false
    if (!wrapInList(listType)(state, dispatch, view)) return false
    if (!task || dispatch === undefined || view === undefined) return true
    // チェックボックスは「包んでから checked を付ける」の 2 段。包んだ**後の state** を見る。
    // ⚠️ ここで outline 機能を参照しない (機能フォルダごと消せる状態を保つため)
    const $pos = view.state.selection.$from
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type !== itemType) continue
      const itemPos = $pos.before(depth)
      const item = view.state.doc.nodeAt(itemPos)
      if (item !== null) {
        view.dispatch(view.state.tr.setNodeMarkup(itemPos, undefined, { ...item.attrs, checked: false }))
      }
      break
    }
    return true
  }
}

/**
 * callout は「1 行目が `[!note]` の引用」。引用に包んでからその文字を置く。
 * ⚠️ 末尾を空白で終えない: `> [!note] ` はファイルに `&#x20;` として書かれてしまう。
 * 差し替える前提のタイトルを選択状態で置く (ハイライトと同じ形)。
 */
const insertCallout: Command = (state, dispatch, view) => {
  const quote = type(state, 'blockquote')
  if (quote === undefined) return false
  if (!wrapIn(quote)(state, dispatch, view)) return false
  if (dispatch === undefined || view === undefined) return true
  const from = view.state.selection.from
  const text = '[!note] タイトル'
  const tr = view.state.tr.insertText(text)
  const inner = from + '[!note] '.length
  tr.setSelection(TextSelection.create(tr.doc, inner, inner + 'タイトル'.length))
  view.dispatch(tr.scrollIntoView())
  return true
}

const toQuote: Command = (state, dispatch, view) => {
  const quote = type(state, 'blockquote')
  return quote === undefined ? false : wrapIn(quote)(state, dispatch, view)
}

const insertHr: Command = (state, dispatch) => {
  const hr = type(state, 'hr') ?? type(state, 'horizontal_rule')
  if (hr === undefined) return false
  dispatch?.(state.tr.replaceSelectionWith(hr.create()).scrollIntoView())
  return true
}

/** 3 列 2 行の表 (見出し行 + 1 行)。GFM の表そのものなので Markdown に往復する */
const insertTable: Command = (state, dispatch) => {
  const table = type(state, 'table')
  const row = type(state, 'table_row')
  const header = type(state, 'table_header')
  const cell = type(state, 'table_cell')
  const paragraph = type(state, 'paragraph')
  if (table === undefined || row === undefined || header === undefined
    || cell === undefined || paragraph === undefined) return false

  // alignment の既定は 'left' で、そのまま入れると `| :- |` になる。
  // 指定していない表は `| - |` で書きたいので null にする
  const emptyCell = (nodeType: NodeType): ReturnType<NodeType['createAndFill']> =>
    nodeType.createAndFill({ alignment: null }, paragraph.create())
  const cells = (nodeType: NodeType): NonNullable<ReturnType<NodeType['createAndFill']>>[] =>
    [0, 1, 2].map(() => emptyCell(nodeType)).filter((node) => node !== null)

  // createAndFill は足りない行を勝手に足すので使わない (空行が 1 本増える)
  const node = table.create(null, [row.create(null, cells(header)), row.create(null, cells(cell))])
  const tr = state.tr.replaceSelectionWith(node)
  // 先頭のセルへカーソルを置く
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(state.selection.from, 1))))
  dispatch?.(tr.scrollIntoView())
  return true
}

/**
 * インラインの記法を置く (task #51)。
 *
 * ⚠️ **カーソルだけの状態で toggleMark しても続きは打てない。** インラインコードのマークは
 * `inclusive: false` なので、1 文字打った時点で外に出てしまう (実測: `` `c`onst ``)。
 * 差し替える前提のプレースホルダを入れて、それを選択した状態で渡す。
 */
function insertInline(name: string, placeholder: string): Command {
  return (state, dispatch) => {
    const mark = state.schema.marks[name]
    if (mark === undefined) return false
    const from = state.selection.from
    const tr = state.tr.replaceSelectionWith(state.schema.text(placeholder, [mark.create()]), false)
    tr.setSelection(TextSelection.create(tr.doc, from, from + placeholder.length))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** 今日の日付 (ISO)。ジャーナルのファイル名と同じ書き方に揃える */
const insertToday: Command = (state, dispatch) => {
  const now = new Date()
  const iso = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  dispatch?.(state.tr.insertText(iso).scrollIntoView())
  return true
}

/**
 * 記号で挟んだテキストを置き、中身を選択した状態にする (task #13 のハイライト)。
 * `==…==` はマークではなくただのテキストなので、文字として入れる。
 */
function insertWrapped(open: string, close: string, placeholder: string): Command {
  return (state, dispatch) => {
    const from = state.selection.from
    const tr = state.tr.insertText(`${open}${placeholder}${close}`, from, state.selection.to)
    const inner = from + open.length
    tr.setSelection(TextSelection.create(tr.doc, inner, inner + placeholder.length))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** そのまま文字を置く候補 (置いたあと別の補完に引き継ぐ) */
function insertText(text: string): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.insertText(text).scrollIntoView())
    return true
  }
}

export interface SlashItem extends SuggestItem {
  /** 探すときの手がかり (かな読みと英語の両方) */
  keywords: string[]
  run: Command
}

/** 候補。**標準 Markdown に落ちるものだけ** */
export const SLASH_ITEMS: SlashItem[] = [
  { value: 'h1', title: '見出し 1', subtitle: '#', keywords: ['みだし', 'midashi', 'heading', 'h1'], run: toBlock('heading', { level: 1 }) },
  { value: 'h2', title: '見出し 2', subtitle: '##', keywords: ['みだし', 'midashi', 'heading', 'h2'], run: toBlock('heading', { level: 2 }) },
  { value: 'h3', title: '見出し 3', subtitle: '###', keywords: ['みだし', 'midashi', 'heading', 'h3'], run: toBlock('heading', { level: 3 }) },
  { value: 'bullet', title: '箇条書き', subtitle: '- ', keywords: ['かじょうがき', 'list', 'ul', 'kajogaki'], run: toList('bullet_list') },
  { value: 'ordered', title: '番号付きリスト', subtitle: '1. ', keywords: ['ばんごう', 'list', 'ol', 'bangou'], run: toList('ordered_list') },
  { value: 'task', title: 'チェックボックス', subtitle: '- [ ] ', keywords: ['ちぇっく', 'todo', 'task', 'check'], run: toList('bullet_list', true) },
  { value: 'quote', title: '引用', subtitle: '> ', keywords: ['いんよう', 'quote', 'inyou'], run: toQuote },
  { value: 'code', title: 'コードブロック', subtitle: '```', keywords: ['こーど', 'code', 'fence'], run: toBlock('code_block') },
  { value: 'table', title: '表', subtitle: '| a | b |', keywords: ['ひょう', 'table', 'hyou'], run: insertTable },
  { value: 'hr', title: '区切り線', subtitle: '---', keywords: ['くぎり', 'hr', 'divider', 'kugiri'], run: insertHr },
  { value: 'link', title: 'ノートへのリンク', subtitle: '[[', keywords: ['りんく', 'link', 'wikilink', 'rinku'], run: insertText('[[') },
  { value: 'tag', title: 'タグ', subtitle: '#tag', keywords: ['たぐ', 'tag', 'tagu'], run: insertText('#') },
  // --- ここからインライン (task #51)。数式とハイライトは記法が通ってから (#13 / #14) ---
  { value: 'inline-code', title: 'インラインコード', subtitle: '`…`', keywords: ['こーど', 'code', 'inline'], run: insertInline('inlineCode', 'コード') },
  { value: 'today', title: '今日の日付', subtitle: '2026-01-01', keywords: ['ひづけ', 'date', 'today', 'kyou'], run: insertToday },
  { value: 'highlight', title: 'ハイライト', subtitle: '==…==', keywords: ['はいらいと', 'highlight', 'mark'], run: insertWrapped('==', '==', 'ハイライト') },
  { value: 'callout', title: 'callout (注記)', subtitle: '> [!note]', keywords: ['ちゅうき', 'callout', 'note', 'admonition'], run: insertCallout },
]

const fold = (text: string): string => text.normalize('NFC').toLowerCase()

export function filterSlashItems(query: string, items: readonly SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const needle = fold(query.trim())
  if (needle === '') return [...items]
  return items.filter((item) =>
    fold(item.title).includes(needle)
    || fold(item.subtitle ?? '').includes(needle)
    || item.keywords.some((keyword) => fold(keyword).startsWith(needle)))
}

/**
 * カーソルの直前が書きかけの `/…` なら、その範囲を返す。
 * 行頭か空白の直後だけを拾う (`foo/bar` のようなパスでは出さない)。
 */
function activeQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  if ($from.parent.type.spec.code === true) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before)
  if (match === null) return null
  const query = match[1] ?? ''
  return { from: $from.pos - query.length, to: $from.pos, query }
}

export const slashSuggest = createSuggest({
  name: 'loamium-slash',
  priority: 10,
  header: (query) => (query === '' ? '挿入' : `挿入: ${query}`),
  match: activeQuery,
  items: (query) => filterSlashItems(query),
  // `/` と入力、それに直前の空白まで消してから `run` を走らせる (既定の apply)
  trigger: { length: 1, eatLeadingSpace: true },
})

export const slash = [$prose(() => slashSuggest)]
