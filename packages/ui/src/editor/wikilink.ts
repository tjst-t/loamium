import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { parseWikiLinks, resolveWikiLink, foldTarget } from '@loamium/shared'
import { getWikiLinkEnv } from './wikilink-env'

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
      const env = getWikiLinkEnv()
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
      const env = getWikiLinkEnv()
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

interface Suggest {
  /** `[[` の直後の位置 */
  from: number
  /** カーソル位置 */
  to: number
  query: string
  index: number
  items: string[]
}

const suggestKey = new PluginKey<SuggestState>('loamium-wikilink-suggest')

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

/** 閉じるときは中身も捨てる (見えないボタンが DOM に残らないように) */
function hidePopup(dom: HTMLElement): void {
  dom.replaceChildren()
  dom.style.display = 'none'
}

function renderPopup(dom: HTMLElement, state: Suggest, view: EditorView): void {
  dom.replaceChildren()
  if (state.items.length === 0) {
    hidePopup(dom)
    return
  }
  // 何のポップアップなのかを明示する (急に出ると何が起きたのか分からない)
  const header = document.createElement('div')
  header.className = 'wikilink-suggest-header'
  header.textContent = state.query === '' ? 'ノートへリンク' : `ノートへリンク: ${state.query}`
  dom.append(header)
  for (const [i, path] of state.items.entries()) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `wikilink-suggest-item${i === state.index ? ' is-active' : ''}`
    const name = document.createElement('span')
    name.className = 'wikilink-suggest-name'
    name.textContent = baseNameOf(path)
    const dir = document.createElement('span')
    dir.className = 'wikilink-suggest-path'
    dir.textContent = path
    item.append(name, dir)
    // mousedown で確定する (click まで待つとエディタが blur してしまう)
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      accept(view, path)
    })
    dom.append(item)
  }
  dom.style.display = 'block'
  // 座標は環境によっては取れない (jsdom には getClientRects が無い)。位置決めだけ諦める
  try {
    const coords = view.coordsAtPos(state.from)
    dom.style.left = `${String(Math.round(coords.left))}px`
    dom.style.top = `${String(Math.round(coords.bottom + 4))}px`
  } catch { /* 位置は据え置き */ }
}

/** 候補を確定して `[[…]]` を閉じる */
export function accept(view: EditorView, path: string): void {
  const active = suggestKey.getState(view.state)?.active
  if (active === null || active === undefined) return
  const env = getWikiLinkEnv()
  // ノート名が一意ならノート名だけで書く (短く読める書き方を既定にする)
  const name = baseNameOf(path)
  const unique = env.notes.filter((p) => foldTarget(baseNameOf(p)) === foldTarget(name)).length <= 1
  const target = unique ? name : path.replace(/\.md$/i, '')
  const tr = view.state.tr.insertText(`${target}]]`, active.from, active.to)
  tr.setSelection(TextSelection.near(tr.doc.resolve(active.from + target.length + 2)))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/**
 * `[[` を打つとノート名の候補が出る。
 *
 * 候補の上下は矢印キー、確定は Enter か Tab、取り消しは Escape。
 * ⚠️ **プラグインの登録順が効く。** Enter / Tab はリストのコマンド (splitListItem /
 * sinkListItem) が先に食うので、このプラグインは preset より**前**に `use()` すること
 * (Editor.tsx / milkdown-transform.ts)。
 */
interface SuggestState {
  active: Suggest | null
  /** Escape で閉じたあと、その `[[…` から抜けるまでは出し直さない */
  dismissed: boolean
}

function computeActive(state: EditorState, index = 0): Suggest | null {
  const found = activeQuery(state)
  if (found === null) return null
  const items = suggestNotes(found.query, getWikiLinkEnv().notes)
  return { ...found, items, index: Math.min(Math.max(index, 0), Math.max(items.length - 1, 0)) }
}

const wikiLinkSuggest = new Plugin<SuggestState>({
  key: suggestKey,
  state: {
    init: () => ({ active: null, dismissed: false }),
    apply(tr, prev, _oldState, nextState) {
      const meta = tr.getMeta(suggestKey) as { close?: boolean; move?: number } | undefined
      if (meta?.close === true) return { active: null, dismissed: true }

      const inQuery = activeQuery(nextState) !== null
      if (prev.dismissed && inQuery) return prev
      if (meta?.move !== undefined && prev.active !== null) {
        const count = prev.active.items.length
        if (count === 0) return prev
        const index = (prev.active.index + meta.move + count) % count
        return { active: { ...prev.active, index }, dismissed: false }
      }
      // **打っている最中だけ**開く。カーソルを動かしただけでは開かない
      // (既存のリンクの中にカーソルを置いただけで候補が出るのを防ぐ)
      if (!tr.docChanged && prev.active === null) return { active: null, dismissed: false }
      return { active: computeActive(nextState, prev.active?.index ?? 0), dismissed: false }
    },
  },

  props: {
    handleKeyDown(view, event) {
      const active = suggestKey.getState(view.state)?.active
      if (active === null || active === undefined || active.items.length === 0) return false
      if (event.key === 'ArrowDown') {
        view.dispatch(view.state.tr.setMeta(suggestKey, { move: 1 }))
        return true
      }
      if (event.key === 'ArrowUp') {
        view.dispatch(view.state.tr.setMeta(suggestKey, { move: -1 }))
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const path = active.items[active.index]
        if (path === undefined) return false
        accept(view, path)
        return true
      }
      if (event.key === 'Escape') {
        view.dispatch(view.state.tr.setMeta(suggestKey, { close: true }))
        return true
      }
      return false
    },
  },

  view(view) {
    const dom = document.createElement('div')
    dom.className = 'wikilink-suggest'
    hidePopup(dom)
    document.body.append(dom)
    const render = (v: EditorView): void => {
      const active = suggestKey.getState(v.state)?.active
      if (active === null || active === undefined) hidePopup(dom)
      else renderPopup(dom, active, v)
    }
    render(view)
    return {
      update: render,
      destroy: () => { dom.remove() },
    }
  },
})

/** 表示・クリックと補完。**preset より前に use すること** */
export const wikilink = [$prose(() => wikiLinkDecorations), $prose(() => wikiLinkSuggest)]

/** テスト用: いま出ている候補 */
export function suggestStateOf(state: EditorState): Suggest | null {
  return suggestKey.getState(state)?.active ?? null
}
