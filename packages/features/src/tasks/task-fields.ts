import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { parseInlineFields } from '@loamium/shared'
import { apiJson } from '@loamium/ui/src/api'
import { rangeToDelete } from '@loamium/ui/src/editor/hidden-range'
import { tasksApi, type TaskVocab, type VocabItem } from './contract'

/**
 * タスクのインラインフィールド `[status:: progress]` (task #19 / ADR-0029)。
 *
 * **スキーマは触らない。** ファイルに書かれているのは Dataview と同じ
 * `[key:: value]` というただのテキストで、それを decoration でピルに見せているだけ。
 * カーソルが触れたら素の Markdown が出る (WikiLink と同じ約束)。
 *
 * 語彙 (取りうる値) はサーバーから取る。**コードに enum を埋めない** —
 * vault の `system/settings.yaml` で変えられる。
 */

let vocab: TaskVocab = { status: [], priority: [] }
let vocabLoaded = false

async function loadVocab(): Promise<void> {
  try {
    vocab = await apiJson<TaskVocab>(tasksApi.vocab())
  } catch {
    // 取れなくても素のテキストとして編集はできる
  }
  vocabLoaded = true
}

/** そのキーの語彙。`due` のように語彙を持たないものは空 */
function itemsFor(key: string): VocabItem[] {
  if (key === 'status') return vocab.status
  if (key === 'priority') return vocab.priority
  return []
}

const labelOf = (key: string, value: string): string =>
  itemsFor(key).find((item) => item.key === value)?.label ?? value

interface Found {
  from: number
  to: number
  key: string
  value: string
}

export function fieldsOf(state: EditorState): Found[] {
  const out: Found[] = []
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || node.text === null || node.text === undefined) return true
    if (parent?.type.spec.code === true) return false
    if (node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === 'inlineCode')) return true
    for (const field of parseInlineFields(node.text)) {
      out.push({ from: pos + field.start, to: pos + field.end, key: field.key, value: field.value })
    }
    return true
  })
  return out
}

/** その位置を含むリスト項目 (チェックボックスと同期するために要る) */
function listItemAt(state: EditorState, pos: number): { node: ProseNode; pos: number } | null {
  const $pos = state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type.name === 'list_item' || node.type.name === 'listItem') {
      return { node, pos: $pos.before(depth) }
    }
  }
  return null
}

/**
 * 値を変える。**status は完了と互いに追従する** (ADR-0029)。
 * `done: true` の status を選べばチェックも入り、そうでなければ外れる。
 */
function setValue(view: EditorView, found: Found, value: string | null): void {
  // ⚠️ **位置を取り直してから書く。** メニューを開いたあとに本文が動くことがあり
  //    (別の差し込み・エージェントの書き込み)、掴んだままの位置で置換すると
  //    無関係な文字を消す (実機でタスク行が `-` だけになった)
  const current = fieldsOf(view.state).find((f) => f.key === found.key && f.from === found.from)
    ?? fieldsOf(view.state).find((f) => f.key === found.key && f.value === found.value)
  if (current === undefined) return
  const text = value === null ? '' : `[${found.key}:: ${value}]`
  const tr = view.state.tr.insertText(text, current.from, current.to)
  if (found.key === 'status' && value !== null) {
    const item = vocab.status.find((s) => s.key === value)
    const list = listItemAt(view.state, current.from)
    if (item !== undefined && list !== null && 'checked' in list.node.attrs) {
      tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, checked: item.done === true })
    }
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 開いているメニューを閉じる (本文が変わったら呼ぶ) */
let closeMenu: (() => void) | null = null

/** ピルを押したときに出す小さな選択肢 */
function openMenu(view: EditorView, anchor: HTMLElement, found: Found): void {
  closeMenu?.()
  document.querySelector('.task-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'task-menu'

  const choose = (value: string | null): void => {
    closeMenu?.()
    setValue(view, found, value)
  }

  /** 選択肢のボタン (キーボードで動かす対象) */
  const buttons: HTMLButtonElement[] = []
  let index = 0
  const highlight = (): void => {
    for (const [i, button] of buttons.entries()) button.classList.toggle('is-active', i === index)
    // jsdom には scrollIntoView が無い (テストでも同じ経路を通す)
    buttons[index]?.scrollIntoView?.({ block: 'nearest' })
  }

  const items = itemsFor(found.key)
  if (items.length === 0) {
    // 語彙を持たないフィールド (`due` など) はそのまま打てるようにする
    const input = document.createElement('input')
    input.type = found.key === 'due' ? 'date' : 'text'
    input.className = 'task-menu-input'
    input.value = found.value
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); choose(input.value) }
      if (event.key === 'Escape') { event.preventDefault(); menu.remove(); view.focus() }
    })
    input.addEventListener('change', () => { choose(input.value) })
    menu.append(input)
    window.setTimeout(() => { input.focus() }, 0)
  } else {
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `task-menu-item${item.key === found.value ? ' is-current' : ''}`
      button.textContent = item.label
      button.addEventListener('mousedown', (event) => { event.preventDefault(); choose(item.key) })
      menu.append(button)
      buttons.push(button)
      // いまの値から始める (押した値がそのまま選ばれた状態で開く)
      if (item.key === found.value) index = buttons.length - 1
    }
  }

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'task-menu-item is-danger'
  remove.textContent = 'このフィールドを消す'
  remove.addEventListener('mousedown', (event) => { event.preventDefault(); choose(null) })
  menu.append(remove)
  buttons.push(remove)

  /**
   * ⚠️ **キーボードで選べること。** マウス専用のメニューは、差し込んだ直後に
   * 手がキーボードにある流れ (`/期限` → Enter) と噛み合わない。
   */
  menu.tabIndex = -1
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu?.(); view.focus(); return }
    if (buttons.length === 0) return
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      index = (index + 1) % buttons.length
      highlight()
    } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      index = (index - 1 + buttons.length) % buttons.length
      highlight()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      buttons[index]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    }
  })

  document.body.append(menu)
  const box = anchor.getBoundingClientRect()
  const size = menu.getBoundingClientRect()
  menu.style.left = `${String(Math.round(Math.min(box.left, window.innerWidth - size.width - 8)))}px`
  menu.style.top = `${String(Math.round(box.bottom + 4 + size.height > window.innerHeight ? box.top - size.height - 4 : box.bottom + 4))}px`

  const dismiss = (): void => {
    menu.remove()
    window.removeEventListener('mousedown', close, true)
    closeMenu = null
  }
  const close = (event: MouseEvent): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return
    dismiss()
  }
  window.addEventListener('mousedown', close, true)
  closeMenu = dismiss
  // 語彙があるときはメニュー自身にフォーカスを移す (日付入力は input が持っていく)
  if (items.length > 0) {
    highlight()
    window.setTimeout(() => { menu.focus() }, 0)
  }
}

function pillFor(view: EditorView, found: Found): HTMLElement {
  const pill = document.createElement('button')
  pill.type = 'button'
  pill.className = `task-field is-${found.key} is-value-${found.value.replace(/[^\w-]/g, '')}`
  pill.contentEditable = 'false'
  pill.dataset['from'] = String(found.from)
  pill.title = `${found.key}: ${found.value} (押すと変えられます)`
  pill.textContent = found.key === 'due' ? `期限 ${found.value}` : labelOf(found.key, found.value)
  pill.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openMenu(view, pill, found)
  })
  return pill
}

const fieldsKey = new PluginKey<number | null>('loamium-task-fields')

/** 差し込まれたテキストが丸ごと 1 つのインラインフィールドか */
const INSERTED_FIELD = /^\[[A-Za-z_][\w-]*::[^\]]*\]$/

const fieldsPlugin = new Plugin<number | null>({
  key: fieldsKey,

  /**
   * `/状態` などで差し込まれた直後は、**そのまま選択肢を出す**。
   * 差し込んだだけでは「何が選べるのか」が分からず、値を手で打つことになる
   * (実機で「最初の 1 回だけメニューが出ない」と言われた)。
   */
  state: {
    init: () => null,
    apply(tr, value) {
      let inserted: number | null = null
      for (const step of tr.steps) {
        // ⚠️ **テキストだけの差し込みに限る。** ノードを含む slice に textBetween(0, size) を
        //    かけると "Position N outside of fragment" で state の更新ごと落ち、
        //    本文が壊れる (実機でタスク行が `-` だけになった)
        const slice = (step as { slice?: { content?: { firstChild: ProseNode | null; childCount: number } } }).slice
        const child = slice?.content?.firstChild
        if (child === null || child === undefined || slice?.content?.childCount !== 1 || !child.isText) continue
        const text = child.text ?? ''
        // ⚠️ 前後の空白ごと差し込まれることがある (スラッシュの候補が先頭の空白を食うので、
        //    こちらで 1 つ足している)。トリムしてから見て、位置はそのぶんずらす
        const trimmed = text.trimStart()
        if (!INSERTED_FIELD.test(trimmed.trimEnd())) continue
        inserted = (step as unknown as { from: number }).from + (text.length - trimmed.length)
      }
      if (tr.getMeta(fieldsKey) === null && tr.steps.length === 0) return null
      if (inserted !== null) return inserted
      return value === null ? null : tr.mapping.map(value)
    },
  },

  view(view) {
    void loadVocab().then(() => { if (!view.isDestroyed) view.dispatch(view.state.tr) })
    let shown: number | null = null
    return {
      update(updated, prev) {
        if (prev.doc !== updated.state.doc) closeMenu?.()
        const at = fieldsKey.getState(updated.state)
        if (at === null || at === undefined || at === shown) return
        const found = fieldsOf(updated.state).find((f) => f.from === at)
        const pill = document.querySelector(`.task-field[data-from="${String(at)}"]`)
        if (found === undefined || !(pill instanceof HTMLElement)) return
        // 一度出したら忘れる (同じ場所で何度も開かない)。
        // ⚠️ update の中で dispatch しない (ProseMirror が再入する)
        shown = at
        window.setTimeout(() => { openMenu(updated, pill, found) }, 0)
      },
    }
  },

  /**
   * チェックボックスを直接押したときも `[status:: …]` を追従させる。
   * ⚠️ **status を持たない行には何も足さない** (単純なタスクを複雑にしない)。
   */
  appendTransaction(_transactions, oldState, newState): Transaction | null {
    if (oldState.doc === newState.doc || vocab.status.length === 0) return null
    let tr: Transaction | null = null
    newState.doc.descendants((node, pos) => {
      if (!('checked' in node.attrs)) return true
      // ⚠️ **古い doc の範囲外を触らない。** 位置は新しい doc のもので、文字が増えていれば
      //    古い doc からははみ出す。`nodeAt` に渡すと RangeError で state 更新ごと落ち、
      //    本文が壊れる (実機でタスク行が `-` だけになった)
      if (pos >= oldState.doc.content.size) return true
      const before = oldState.doc.nodeAt(pos)
      if (before?.type !== node.type || before.attrs['checked'] === node.attrs['checked']) return true
      const checked = node.attrs['checked'] === true
      // ⚠️ 位置は**ドキュメント座標で取り直す**。node の中の文字数から足し算すると
      //    段落やマークのぶんだけずれて、`[status:: todo]]` のように壊れる (実機で発生)
      const field = fieldsOf(newState).find((f) =>
        f.key === 'status' && f.from >= pos && f.to <= pos + node.nodeSize)
      if (field === undefined) return true
      const wanted = checked
        ? vocab.status.find((s) => s.done === true)
        : vocab.status.find((s) => s.done !== true)
      if (wanted === undefined || wanted.key === field.value) return true
      tr = (tr ?? newState.tr).insertText(`[status:: ${wanted.key}]`, field.from, field.to)
      return false
    })
    return tr
  },

  props: {
    /**
     * ⚠️ **ピルは Backspace / Delete で 1 回で消える。**
     * 記法は隠れているので、素の Backspace だと見えない文字を 1 つずつ削ることになる
     * (`[status:: todo]` を消すのに 16 回。実機で「消せない」と言われた)。
     */
    handleKeyDown(view, event) {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false
      const range = rangeToDelete(view.state, event.key === 'Backspace', fieldsOf(view.state))
      if (range === null) return false
      event.preventDefault()
      // 直前の空白も一緒に消す (`やること [due:: …]` → `やること`)
      const before = view.state.doc.textBetween(Math.max(range.from - 1, 0), range.from)
      const from = before === ' ' ? range.from - 1 : range.from
      view.dispatch(view.state.tr.delete(from, range.to).scrollIntoView())
      return true
    },

    decorations(state) {
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      for (const found of fieldsOf(state)) {
        // ⚠️ 素の Markdown を見せるのは**括弧の中**にカーソルがあるときだけ。
        //    端に触れただけで生に戻すと、差し込んだ直後 (カーソルは `]` の直後) に
        //    ピルが出ず、選択肢を出す取っかかりが無くなる
        if (selFrom > found.from && selTo < found.to) continue
        decorations.push(Decoration.inline(found.from, found.to, { class: 'task-field-syntax' }))
        decorations.push(Decoration.widget(found.to, (view) => pillFor(view, found), {
          side: 1,
          key: `task-${String(found.from)}-${found.key}-${found.value}-${vocabLoaded ? 'ready' : 'loading'}`,
          ignoreSelection: true,
        }))
      }
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

export const taskFields = [$prose(() => fieldsPlugin)]
