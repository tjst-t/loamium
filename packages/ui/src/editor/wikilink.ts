import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { parseWikiLinks, resolveWikiLink, foldTarget } from '@loamium/shared'
import { createSuggest, type SuggestItem } from './suggest'
import { getEditorEnv } from './editor-env'

/**
 * WikiLink `[[…]]` (task #4)。
 *
 * **スキーマにノードを足さない。** `[[…]]` はただのテキストのまま置き、見た目とクリックだけを
 * decoration で足す。こうすると serializer を一切触らないので、round-trip 保存性
 * (不変条件 2) に手を入れずに済み、外部エディタで開いたときの見え方とも完全に一致する。
 */

interface DocLink {
  from: number
  to: number
  target: string
  /** `[[` から `]]` までそのまま */
  raw: string
}

/** テキストノード内の `[[…]]` を拾う。コードの中は shared 側が除外する */
function linksInDoc(state: EditorState): DocLink[] {
  const out: DocLink[] = []
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || node.text === null || node.text === undefined) return true
    // コードブロック・インラインコードの中はリンクではない
    if (parent?.type.spec.code === true) return false
    if (node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === 'inlineCode')) return true
    for (const link of parseWikiLinks(node.text)) {
      out.push({ from: pos + link.start, to: pos + link.end, target: link.target, raw: link.raw })
    }
    return true
  })
  return out
}

/**
 * 記法 (`[[` `]]` と表示名の前) を隠して、リンクらしく見せる。
 *
 * ⚠️ **カーソルがそのリンクに触れている間は隠さない。** 隠しっぱなしだと、消したり
 * 書き換えたりするときに「見えない文字」を相手にすることになる。触れたら素の Markdown が
 * そのまま出る、という往復を常に成り立たせておく。
 *
 * これは「行単位の Raw 表示」(CLAUDE.md で不採用) ではない。行ではなくリンク 1 個の単位で、
 * 隠しているのは**記法の飾りだけ**。ファイルの中身は 1 バイトも変えない。
 */
function syntaxDecorations(link: DocLink): Decoration[] {
  const decorations = [
    Decoration.inline(link.from, link.from + 2, { class: 'wikilink-syntax' }),
    Decoration.inline(link.to - 2, link.to, { class: 'wikilink-syntax' }),
  ]
  // 表示名があるなら、その前 (`ノート#見出し|`) はまるごと隠して表示名だけ見せる
  const bar = link.raw.indexOf('|')
  if (bar > 2) decorations.push(Decoration.inline(link.from + 2, link.from + bar + 1, { class: 'wikilink-syntax' }))
  return decorations
}

const wikiLinkDecorations = new Plugin({
  key: new PluginKey('loamium-wikilink'),
  props: {
    decorations(state) {
      const env = getEditorEnv()
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      for (const link of linksInDoc(state)) {
        const path = resolveWikiLink(link.target, env.notes, env.currentPath)
        decorations.push(Decoration.inline(link.from, link.to, {
          class: path === null ? 'wikilink is-broken' : 'wikilink',
          'data-target': link.target,
          ...(path === null ? {} : { 'data-path': path }),
          title: path === null ? `${link.target} — まだ無いノート (クリックで作成)` : path,
        }))
        // カーソルが触れているリンクは素の Markdown を見せる
        if (selTo >= link.from && selFrom <= link.to) continue
        decorations.push(...syntaxDecorations(link))
      }
      return DecorationSet.create(state.doc, decorations)
    },

    /** クリックで追従する。壊れリンクは新規作成の導線へ回す */
    handleClick(_view, _pos, event) {
      const el = event.target instanceof HTMLElement ? event.target.closest('.wikilink') : null
      if (!(el instanceof HTMLElement)) return false
      const env = getEditorEnv()
      const path = el.dataset['path']
      const target = el.dataset['target'] ?? ''
      if (path !== undefined && path !== '') env.open(path)
      else if (target !== '') env.create(target)
      return true
    },
  },
})

/* ------------------------------------------------------------------- 補完 */

const MAX_SUGGESTIONS = 8

const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/** 補完候補。ノート名の前方一致 → ノート名の部分一致 → パスの部分一致 の順 */
export function suggestNotes(query: string, notes: readonly string[]): string[] {
  const needle = foldTarget(query.trim())
  const score = (path: string): number => {
    const name = foldTarget(baseNameOf(path))
    if (needle === '') return 1
    if (name.startsWith(needle)) return 0
    if (name.includes(needle)) return 1
    if (foldTarget(path).includes(needle)) return 2
    return -1
  }
  return notes
    .map((path) => ({ path, rank: score(path) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path, 'ja'))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.path)
}

/**
 * カーソルの直前が**書きかけの** `[[…` なら、その範囲を返す。
 *
 * ⚠️ **すでに閉じているリンクの中では出さないこと。** `[[ノート]]` の `[[` の直後を
 * クリックしただけで候補が開くと、何が出ているのか分からないポップアップになる (実機で発生)。
 */
function activeQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  if ($from.parent.type.spec.code === true) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const match = /\[\[([^[\]\n|#]*)$/.exec(before)
  if (match === null) return null
  // カーソルより後ろで `]]` が閉じているなら、それは書きかけではなく既存のリンク
  const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, undefined, '￼')
  if (/^[^[\]\n]*\]\]/.test(after)) return null
  const query = match[1] ?? ''
  return { from: $from.pos - query.length, to: $from.pos, query }
}

export const wikiLinkSuggest = createSuggest({
  name: 'loamium-wikilink-suggest',
  header: (query) => (query === '' ? 'ノートへリンク' : `ノートへリンク: ${query}`),
  match: activeQuery,
  items: (query) => suggestNotes(query, getEditorEnv().notes).map((path) => ({
    title: baseNameOf(path),
    subtitle: path,
    value: path,
  })),
  apply: (view, item, range) => {
    const env = getEditorEnv()
    // ノート名が一意ならノート名だけで書く (短く読める書き方を既定にする)
    const name = baseNameOf(item.value)
    const unique = env.notes.filter((p) => foldTarget(baseNameOf(p)) === foldTarget(name)).length <= 1
    const target = unique ? name : item.value.replace(/\.md$/i, '')
    const tr = view.state.tr.insertText(`${target}]]`, range.from, range.to)
    tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + target.length + 2)))
    view.dispatch(tr.scrollIntoView())
  },
})

/** 表示・クリックと補完。**preset より前に use すること** */
export const wikilink = [$prose(() => wikiLinkDecorations), $prose(() => wikiLinkSuggest)]

/** テスト用: いま出ている候補 */
export function suggestStateOf(state: EditorState): { items: SuggestItem[]; index: number } | null {
  return wikiLinkSuggest.activeState(state)
}

/** テスト用・後方互換: 候補を確定する */
export function accept(view: Parameters<typeof wikiLinkSuggest.accept>[0], path: string): void {
  wikiLinkSuggest.accept(view, { title: baseNameOf(path), subtitle: path, value: path })
}
