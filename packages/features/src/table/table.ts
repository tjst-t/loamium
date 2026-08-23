import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type Command, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  TableMap, addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable,
  isInTable, moveTableColumn, moveTableRow, selectedRect,
} from '@milkdown/kit/prose/tables'

/**
 * 表の WYSIWYG 編集 (task #15)。
 *
 * **スキーマも serializer も触らない。** 表は GFM の表そのもの (preset が持っている) で、
 * ここで足すのは「行や列を動かす入口」だけ。保存は `normalizeForSave()` を通るので、
 * 何をしても正規形の Markdown テーブルに戻る。
 *
 * 出し方は選択バブル (task #50) と同じ考え方: **セルにカーソルが入ったときだけ**
 * 表の上に操作バーを出す。ホバーで出すと、読んでいるだけで表の上に物が出て邪魔になる。
 */

export interface TableAction {
  id: string
  /** ボタンに出す短い文字 */
  label: string
  /** 何をするか (tooltip と aria-label) */
  title: string
  /** いま押せるか (見出し行を消す等、表を壊す操作は塞ぐ) */
  enabled: (state: EditorState) => boolean
  run: Command
}

interface Rect {
  top: number
  left: number
  rows: number
  cols: number
}

/** カーソルのあるセルの位置。表の外なら null */
export function cellRect(state: EditorState): Rect | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  const map = TableMap.get(rect.table)
  return { top: rect.top, left: rect.left, rows: map.height, cols: map.width }
}

/** 行を動かす。**見出し行 (index 0) は動かさないし、そこへも動かさない** (GFM の表は見出し必須) */
function moveRow(delta: number): Command {
  return (state, dispatch) => {
    const rect = cellRect(state)
    if (rect === null) return false
    const to = rect.top + delta
    if (rect.top === 0 || to < 1 || to > rect.rows - 1) return false
    return moveTableRow({ from: rect.top, to })(state, dispatch)
  }
}

function moveCol(delta: number): Command {
  return (state, dispatch) => {
    const rect = cellRect(state)
    if (rect === null) return false
    const to = rect.left + delta
    if (to < 0 || to > rect.cols - 1) return false
    return moveTableColumn({ from: rect.left, to })(state, dispatch)
  }
}

/**
 * 列を足す。
 *
 * ⚠️ **新しい見出しセルの alignment を消すこと。** prosemirror-tables が作るセルは
 * スキーマ既定の `left` を持つので、そのままだと書いた覚えのない `:-` が
 * 区切り行に現れる (指定していない表は `| - |` で書きたい)。
 * 本文側のセルは gfm の keepTableAlignPlugin が見出しに揃えてくれる。
 */
const addCol: Command = (state, dispatch) => {
  const rect = cellRect(state)
  if (rect === null) return false
  const { tableStart } = selectedRect(state)
  return addColumnAfter(state, (tr) => {
    const table = tr.doc.nodeAt(tableStart - 1)
    const header = table?.firstChild
    header?.forEach((cell, offset, index) => {
      if (index === rect.left + 1) {
        tr.setNodeMarkup(tableStart + 1 + offset, undefined, { ...cell.attrs, alignment: null })
      }
    })
    dispatch?.(tr)
  })
}

const inBody = (state: EditorState): boolean => (cellRect(state)?.top ?? 0) > 0
const canMoveRow = (delta: number) => (state: EditorState): boolean => {
  const rect = cellRect(state)
  if (rect === null || rect.top === 0) return false
  const to = rect.top + delta
  return to >= 1 && to <= rect.rows - 1
}
const canMoveCol = (delta: number) => (state: EditorState): boolean => {
  const rect = cellRect(state)
  if (rect === null) return false
  const to = rect.left + delta
  return to >= 0 && to <= rect.cols - 1
}

export const TABLE_ACTIONS: TableAction[] = [
  { id: 'row-add', label: '行 +', title: '下に行を追加', enabled: (s) => cellRect(s) !== null, run: addRowAfter },
  // ⚠️ 見出し行は消させない。消すと GFM の表として成立しなくなる (表ごと消えたように見える)
  { id: 'row-del', label: '行 −', title: 'この行を削除', enabled: inBody, run: deleteRow },
  { id: 'row-up', label: '行 ↑', title: '行を上へ', enabled: canMoveRow(-1), run: moveRow(-1) },
  { id: 'row-down', label: '行 ↓', title: '行を下へ', enabled: canMoveRow(1), run: moveRow(1) },
  { id: 'col-add', label: '列 +', title: '右に列を追加', enabled: (s) => cellRect(s) !== null, run: addCol },
  { id: 'col-del', label: '列 −', title: 'この列を削除', enabled: (s) => (cellRect(s)?.cols ?? 0) > 1, run: deleteColumn },
  { id: 'col-left', label: '列 ←', title: '列を左へ', enabled: canMoveCol(-1), run: moveCol(-1) },
  { id: 'col-right', label: '列 →', title: '列を右へ', enabled: canMoveCol(1), run: moveCol(1) },
  { id: 'table-del', label: '表を削除', title: '表ごと削除', enabled: (s) => cellRect(s) !== null, run: deleteTable },
]

function build(view: EditorView, dom: HTMLElement): void {
  dom.replaceChildren()
  for (const action of TABLE_ACTIONS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `table-button${action.id === 'table-del' ? ' is-danger' : ''}`
    button.textContent = action.label
    button.title = action.title
    button.setAttribute('aria-label', action.title)
    button.disabled = !action.enabled(view.state)
    // mousedown で実行する (click まで待つとセルのカーソルが外れて、どの行かが分からなくなる)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      action.run(view.state, view.dispatch.bind(view), view)
      view.focus()
    })
    dom.append(button)
  }
}

/** 表の右上・外側に置く (中身に重ねない。block-actions と同じ考え方) */
function place(view: EditorView, dom: HTMLElement): void {
  const rect = selectedRect(view.state)
  const table = view.nodeDOM(rect.tableStart - 1)
  if (!(table instanceof HTMLElement)) return
  const box = table.getBoundingClientRect()
  const bar = dom.getBoundingClientRect()
  const left = Math.min(Math.max(box.right - bar.width, 8), window.innerWidth - bar.width - 8)
  const above = box.top - bar.height - 6
  dom.style.left = `${String(Math.round(left))}px`
  dom.style.top = `${String(Math.round(above > 8 ? above : box.bottom + 6))}px`
}

const barPlugin = new Plugin({
  key: new PluginKey('loamium-table-bar'),
  view(view) {
    const dom = document.createElement('div')
    dom.className = 'table-bar'
    dom.style.display = 'none'
    document.body.append(dom)

    const render = (v: EditorView): void => {
      if (cellRect(v.state) === null || !v.hasFocus()) {
        dom.style.display = 'none'
        return
      }
      build(v, dom)
      dom.style.display = 'flex'
      place(v, dom)
    }
    render(view)
    return { update: render, destroy: () => { dom.remove() } }
  },
})

export const table = [$prose(() => barPlugin)]
