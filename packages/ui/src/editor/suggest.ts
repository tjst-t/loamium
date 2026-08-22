import { Plugin, PluginKey, type Command, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * 入力補完のポップアップ (`[[` / `#` / `/` で共有)。
 *
 * ⚠️ **プラグインの登録順が効く。** Enter / Tab はリストのコマンド (splitListItem /
 * sinkListItem) が先に食うので、これを使うプラグインは preset より**前**に `use()` すること。
 *
 * ⚠️ **同時に開く候補は 1 つだけ** (task #49)。トリガの条件は同時に成立しうる
 * (例: `#` の直後に `/` を打つ)。どれが勝つかを暗黙のプラグイン順に委ねると、
 * 見えないところで候補が出なくなる。ここで**登録順が優先**と明示的に決める。
 */

/**
 * 登録された suggest。**優先順は config の priority で決める。**
 * ⚠️ 登録順 (= import 順) に頼らないこと: features.ts の import の並びを変えただけで
 * 勝ち負けが変わってしまう (実測で踏んだ)。
 */
const registry: { name: string; key: PluginKey<SuggestState>; priority: number }[] = []

const byPriority = (): typeof registry => [...registry].sort((a, b) => a.priority - b.priority)

/** 自分より先に登録された suggest が既に開いているか */
function earlierIsActive(key: PluginKey<SuggestState>, state: EditorState): boolean {
  for (const entry of byPriority()) {
    if (entry.key === key) return false
    if (entry.key.getState(state)?.active != null) return true
  }
  return false
}

/** テスト用: 登録された suggest の名前 (優先順) */
export function suggestPriority(): string[] {
  return byPriority().map((entry) => entry.name)
}
export interface SuggestRange {
  /** 入力中の語の先頭 (トリガー記号の直後) */
  from: number
  /** カーソル位置 */
  to: number
  query: string
}

export interface SuggestItem {
  /** 一覧の見出し */
  title: string
  /** 見出しの下の補足 (パスなど) */
  subtitle?: string
  /** 確定したときに使う値 */
  value: string
  /**
   * 確定したときに走らせるコマンド。範囲を消したあとに呼ばれる。
   * 候補ごとに挙動が違うもの (スラッシュメニュー) はこれを使う。
   */
  run?: Command
}

export interface SuggestConfig {
  name: string
  /** ポップアップの見出し。何が出ているのか分かるように必ず出す */
  header: (query: string) => string
  /** カーソル直前が「書きかけ」なら、その範囲を返す */
  match: (state: EditorState) => SuggestRange | null
  items: (query: string) => SuggestItem[]
  /**
   * 確定。range を置き換える。
   * 省略すると「トリガと入力を消して `item.run` を走らせる」既定の動きになる
   * (`trigger` の文字数だけ手前まで消す)。
   */
  apply?: (view: EditorView, item: SuggestItem, range: SuggestRange) => void
  /**
   * 優先順 (小さいほど強い)。条件が重なったときに開く 1 つを決める。
   * 既定は 100。**import の並びに依存させないため、必ず明示する。**
   */
  priority?: number
  /**
   * トリガの文字数 (既定の apply が消す範囲に使う)。`/` なら 1、`[[` なら 2。
   * ⚠️ トリガの直前の空白も一緒に消す: 残すとファイルに `&#x20;` として書かれる
   */
  trigger?: { length: number; eatLeadingSpace?: boolean }
}

export interface SuggestState {
  active: (SuggestRange & { items: SuggestItem[]; index: number }) | null
  /** Escape で閉じたあと、その入力から抜けるまでは出し直さない */
  dismissed: boolean
}

export type SuggestPlugin = Plugin<SuggestState> & {
  /** テスト用: いま出ている候補 */
  activeState: (state: EditorState) => SuggestState['active']
  /** テスト用・クリック用: 候補を確定する */
  accept: (view: EditorView, item: SuggestItem) => void
}

/** 閉じるときは中身も捨てる (見えないボタンが DOM に残らないように) */
function hidePopup(dom: HTMLElement): void {
  dom.replaceChildren()
  dom.style.display = 'none'
}

function renderPopup(
  dom: HTMLElement, config: SuggestConfig, state: NonNullable<SuggestState['active']>,
  view: EditorView, accept: (view: EditorView, item: SuggestItem) => void,
): void {
  dom.replaceChildren()
  if (state.items.length === 0) {
    hidePopup(dom)
    return
  }
  // 何のポップアップなのかを明示する (急に出ると何が起きたのか分からない)
  const header = document.createElement('div')
  header.className = 'suggest-header'
  header.textContent = config.header(state.query)
  dom.append(header)

  for (const [i, item] of state.items.entries()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `suggest-item${i === state.index ? ' is-active' : ''}`
    const title = document.createElement('span')
    title.className = 'suggest-title'
    title.textContent = item.title
    button.append(title)
    if (item.subtitle !== undefined && item.subtitle !== '') {
      const subtitle = document.createElement('span')
      subtitle.className = 'suggest-subtitle'
      subtitle.textContent = item.subtitle
      button.append(subtitle)
    }
    // mousedown で確定する (click まで待つとエディタが blur してしまう)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      accept(view, item)
    })
    dom.append(button)
  }

  dom.style.display = 'block'
  // 座標は環境によっては取れない (jsdom には getClientRects が無い)。位置決めだけ諦める
  try {
    const coords = view.coordsAtPos(state.from)
    dom.style.left = `${String(Math.round(coords.left))}px`
    dom.style.top = `${String(Math.round(coords.bottom + 4))}px`
  } catch { /* 位置は据え置き */ }
}

export function createSuggest(config: SuggestConfig): SuggestPlugin {
  const key = new PluginKey<SuggestState>(config.name)
  registry.push({ name: config.name, key, priority: config.priority ?? 100 })

  const compute = (state: EditorState, index = 0): SuggestState['active'] => {
    const range = config.match(state)
    if (range === null) return null
    const items = config.items(range.query)
    return { ...range, items, index: Math.min(Math.max(index, 0), Math.max(items.length - 1, 0)) }
  }

  const defaultApply = (view: EditorView, item: SuggestItem, range: SuggestRange): void => {
    const length = config.trigger?.length ?? 0
    let from = range.from - length
    if (config.trigger?.eatLeadingSpace === true) {
      const before = view.state.doc.textBetween(Math.max(from - 1, 0), from)
      if (before === ' ') from -= 1
    }
    view.dispatch(view.state.tr.delete(from, range.to))
    item.run?.(view.state, view.dispatch.bind(view), view)
  }

  const accept = (view: EditorView, item: SuggestItem): void => {
    const active = key.getState(view.state)?.active
    if (active === null || active === undefined) return
    if (config.apply === undefined) defaultApply(view, item, active)
    else config.apply(view, item, active)
    view.focus()
  }

  const plugin = new Plugin<SuggestState>({
    key,
    state: {
      init: () => ({ active: null, dismissed: false }),
      apply(tr, prev, _oldState, nextState) {
        const meta = tr.getMeta(key) as { close?: boolean; move?: number } | undefined
        if (meta?.close === true) return { active: null, dismissed: true }

        // 先に登録された suggest が開いているなら、こちらは開かない (task #49)
        if (earlierIsActive(key, nextState)) return { active: null, dismissed: false }

        const typing = config.match(nextState) !== null
        if (prev.dismissed && typing) return prev
        if (meta?.move !== undefined && prev.active !== null) {
          const count = prev.active.items.length
          if (count === 0) return prev
          return {
            active: { ...prev.active, index: (prev.active.index + meta.move + count) % count },
            dismissed: false,
          }
        }
        // **打っている最中だけ**開く。カーソルを動かしただけでは開かない
        // (既存の [[リンク]] の中にカーソルを置いただけで候補が出るのを防ぐ)
        if (!tr.docChanged && prev.active === null) return { active: null, dismissed: false }
        return { active: compute(nextState, prev.active?.index ?? 0), dismissed: false }
      },
    },

    props: {
      handleKeyDown(view, event) {
        // ⚠️ IME で変換中の Enter は「変換の確定」。候補の確定に横取りしない
        if (event.isComposing || event.keyCode === 229) return false
        const active = key.getState(view.state)?.active
        if (active === null || active === undefined || active.items.length === 0) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          view.dispatch(view.state.tr.setMeta(key, { move: event.key === 'ArrowDown' ? 1 : -1 }))
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = active.items[active.index]
          if (item === undefined) return false
          accept(view, item)
          return true
        }
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.setMeta(key, { close: true }))
          return true
        }
        return false
      },
    },

    view(view) {
      const dom = document.createElement('div')
      dom.className = 'suggest-popup'
      hidePopup(dom)
      document.body.append(dom)
      const render = (v: EditorView): void => {
        const active = key.getState(v.state)?.active
        if (active === null || active === undefined) hidePopup(dom)
        else renderPopup(dom, config, active, v, accept)
      }
      render(view)
      return { update: render, destroy: () => { dom.remove() } }
    },
  }) as SuggestPlugin

  plugin.activeState = (state) => key.getState(state)?.active ?? null
  plugin.accept = accept
  return plugin
}
