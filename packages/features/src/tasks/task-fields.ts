import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { parseInlineFields } from '@loamium/shared'
import { apiJson } from '@loamium/ui/src/api'
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

function fieldsIn(state: EditorState): Found[] {
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
  const text = value === null ? '' : `[${found.key}:: ${value}]`
  const tr = view.state.tr.insertText(text, found.from, found.to)
  if (found.key === 'status' && value !== null) {
    const item = vocab.status.find((s) => s.key === value)
    const list = listItemAt(view.state, found.from)
    if (item !== undefined && list !== null && 'checked' in list.node.attrs) {
      tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, checked: item.done === true })
    }
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** ピルを押したときに出す小さな選択肢 */
function openMenu(view: EditorView, anchor: HTMLElement, found: Found): void {
  document.querySelector('.task-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'task-menu'

  const choose = (value: string | null): void => {
    menu.remove()
    setValue(view, found, value)
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
    }
  }

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'task-menu-item is-danger'
  remove.textContent = 'このフィールドを消す'
  remove.addEventListener('mousedown', (event) => { event.preventDefault(); choose(null) })
  menu.append(remove)

  document.body.append(menu)
  const box = anchor.getBoundingClientRect()
  const size = menu.getBoundingClientRect()
  menu.style.left = `${String(Math.round(Math.min(box.left, window.innerWidth - size.width - 8)))}px`
  menu.style.top = `${String(Math.round(box.bottom + 4 + size.height > window.innerHeight ? box.top - size.height - 4 : box.bottom + 4))}px`

  const close = (event: MouseEvent): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return
    menu.remove()
    window.removeEventListener('mousedown', close, true)
  }
  window.addEventListener('mousedown', close, true)
}

function pillFor(view: EditorView, found: Found): HTMLElement {
  const pill = document.createElement('button')
  pill.type = 'button'
  pill.className = `task-field is-${found.key} is-value-${found.value.replace(/[^\w-]/g, '')}`
  pill.contentEditable = 'false'
  pill.title = `${found.key}: ${found.value} (押すと変えられます)`
  pill.textContent = found.key === 'due' ? `期限 ${found.value}` : labelOf(found.key, found.value)
  pill.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openMenu(view, pill, found)
  })
  return pill
}

const fieldsPlugin = new Plugin({
  key: new PluginKey('loamium-task-fields'),
  view(view) {
    void loadVocab().then(() => { if (!view.isDestroyed) view.dispatch(view.state.tr) })
    return {}
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
      const before = oldState.doc.nodeAt(pos)
      if (before?.type !== node.type || before.attrs['checked'] === node.attrs['checked']) return true
      const checked = node.attrs['checked'] === true
      // ⚠️ 位置は**ドキュメント座標で取り直す**。node の中の文字数から足し算すると
      //    段落やマークのぶんだけずれて、`[status:: todo]]` のように壊れる (実機で発生)
      const field = fieldsIn(newState).find((f) =>
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
    decorations(state) {
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      for (const found of fieldsIn(state)) {
        // カーソルが触れているものは素の Markdown を見せる (WikiLink と同じ約束)
        if (selTo >= found.from && selFrom <= found.to) continue
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
