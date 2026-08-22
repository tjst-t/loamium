import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { liftListItem, sinkListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import type { Node as ProseNode, NodeType } from '@milkdown/kit/prose/model'

/**
 * アウトライン操作 (task #10)。
 *
 * ADR-0035 / CLAUDE.md の方針どおり、インデントは ProseMirror 標準の
 * `sinkListItem` / `liftListItem` に乗る (旧 outline.ts 1,670 行を再実装しない)。
 * ここで足すのは標準に無いものだけ:
 *
 * - リスト外 Tab でフォーカスがエディタから飛ばないようにする (テーブル内は除く)
 * - リスト種別の変換 (箇条書き ⇄ 番号 ⇄ チェックボックス)
 * - 折りたたみ
 *
 * **折りたたみは decoration だけで表現し、ドキュメントには一切書き込まない。**
 * 不変条件 1 (標準 Markdown が正本) より、折りたたみ状態はファイルに漏れてはならない。
 */

const LIST_ITEM = 'list_item'
const BULLET_LIST = 'bullet_list'
const ORDERED_LIST = 'ordered_list'

type ListKind = 'bullet' | 'ordered' | 'task'

const nodeType = (state: EditorState, name: string): NodeType | undefined => state.schema.nodes[name]

/** カーソルを含む最も内側の list_item の深さ。無ければ null */
function listItemDepth(state: EditorState): number | null {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === LIST_ITEM) return d
  }
  return null
}

function inTable(state: EditorState): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name.startsWith('table')) return true
  }
  return false
}

/* ------------------------------------------------------------------ 種別変換 */

/**
 * リスト内の list_item の attrs をまとめて書き換える。
 *
 * `listType` / `label` も必ず揃えること。preset の `syncListOrderPlugin` は
 * **項目側の listType を見てリストの型を戻してしまう**ので、リストノードだけ
 * 差し替えると番号リストが即座に復活する。
 */
function updateItems(
  tr: Transaction,
  doc: ProseNode,
  listPos: number,
  patch: (attrs: Record<string, unknown>, index: number) => void,
): void {
  const list = doc.nodeAt(listPos)
  if (!list) return
  list.forEach((child, offset, index) => {
    if (child.type.name !== LIST_ITEM) return
    const attrs = { ...child.attrs }
    patch(attrs, index)
    tr.setNodeMarkup(listPos + 1 + offset, undefined, attrs)
  })
}

/** list_item の checked を付け外しする (null = 素のリスト項目 / false = 未完了) */
function setChecked(tr: Transaction, doc: ProseNode, listPos: number, checked: boolean | null): void {
  updateItems(tr, doc, listPos, (attrs) => {
    attrs['checked'] = checked
  })
}

/**
 * カーソルのあるリストを箇条書き / 番号 / チェックボックスへ変換する。
 * リストの外なら、その段落をリストに包む。
 */
export function setListKind(kind: ListKind): Command {
  return (state, dispatch) => {
    const bullet = nodeType(state, BULLET_LIST)
    const ordered = nodeType(state, ORDERED_LIST)
    if (!bullet || !ordered) return false

    const depth = listItemDepth(state)
    if (depth === null) {
      // リストの外: 包む (チェックボックスは箇条書きに包んでから checked を付ける)
      const wrap = wrapInList(kind === 'ordered' ? ordered : bullet)
      if (!dispatch) return wrap(state)
      return wrap(state, (tr) => {
        if (kind === 'task') {
          const $pos = tr.doc.resolve(tr.selection.from)
          for (let d = $pos.depth; d > 0; d--) {
            if ($pos.node(d).type.name === LIST_ITEM) {
              setChecked(tr, tr.doc, $pos.before(d - 1), false)
              break
            }
          }
        }
        dispatch(tr)
      })
    }

    const listDepth = depth - 1
    const listNode = state.selection.$from.node(listDepth)
    const listPos = state.selection.$from.before(listDepth)
    const targetType = kind === 'ordered' ? ordered : bullet

    const tr = state.tr
    if (listNode.type !== targetType) {
      tr.setNodeMarkup(listPos, targetType, { ...listNode.attrs })
      updateItems(tr, state.doc, listPos, (attrs, index) => {
        attrs['listType'] = kind === 'ordered' ? 'ordered' : 'bullet'
        attrs['label'] = kind === 'ordered' ? `${index + 1}.` : '•'
      })
    }
    const alreadyTask = listNode.firstChild?.attrs['checked'] != null
    if (kind === 'task') {
      if (!alreadyTask) setChecked(tr, state.doc, listPos, false)
    } else if (alreadyTask) {
      setChecked(tr, state.doc, listPos, null)
    }
    if (!tr.docChanged) return false
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/** チェックボックスの完了/未完了を切り替える (チェックボックスでなければ false) */
export const toggleTaskChecked: Command = (state, dispatch) => {
  const depth = listItemDepth(state)
  if (depth === null) return false
  const item = state.selection.$from.node(depth)
  if (item.attrs['checked'] == null) return false
  const pos = state.selection.$from.before(depth)
  dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: !item.attrs['checked'] }))
  return true
}

/* -------------------------------------------------------------- 折りたたみ */

export const foldKey = new PluginKey<DecorationSet>('loamium-outline-fold')

/** 子リストを持つ list_item か */
function hasChildList(node: ProseNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const name = node.child(i).type.name
    if (name === BULLET_LIST || name === ORDERED_LIST) return true
  }
  return false
}

function foldedAt(set: DecorationSet, pos: number): Decoration | undefined {
  return set.find(pos, pos + 1).find((d) => d.from === pos)
}

interface FoldMeta {
  pos: number
}

/** カーソルのある list_item の折りたたみを切り替える */
export const toggleFold: Command = (state, dispatch) => {
  const depth = listItemDepth(state)
  if (depth === null) return false
  const pos = state.selection.$from.before(depth)
  const node = state.doc.nodeAt(pos)
  if (!node || !hasChildList(node)) return false
  dispatch?.(state.tr.setMeta(foldKey, { pos } satisfies FoldMeta))
  return true
}

function toggleButton(view: EditorView, pos: number, collapsed: boolean): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'outline-fold-toggle'
  button.setAttribute('aria-expanded', String(!collapsed))
  button.setAttribute('aria-label', collapsed ? '展開' : '折りたたむ')
  button.contentEditable = 'false'
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    view.dispatch(view.state.tr.setMeta(foldKey, { pos } satisfies FoldMeta))
  })
  return button
}

/** チェックボックス (GFM task list) の実体。decoration なのでファイルには出ない */
function taskCheckbox(view: EditorView, pos: number, checked: boolean): HTMLElement {
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'outline-task-checkbox'
  input.checked = checked
  input.contentEditable = 'false'
  input.addEventListener('mousedown', (event) => {
    event.preventDefault()
    const node = view.state.doc.nodeAt(pos)
    if (!node) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !checked }))
  })
  return input
}

/**
 * 折りたたみ状態は plugin state の DecorationSet だけが持つ。
 * 編集で位置がずれても `map` が追従し、ノードが消えれば decoration も消える。
 */
const foldPlugin = new Plugin<DecorationSet>({
  key: foldKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc)
      const meta = tr.getMeta(foldKey) as FoldMeta | undefined
      if (meta) {
        const existing = foldedAt(next, meta.pos)
        if (existing) {
          next = next.remove([existing])
        } else {
          const node = tr.doc.nodeAt(meta.pos)
          if (node) {
            next = next.add(tr.doc, [
              Decoration.node(meta.pos, meta.pos + node.nodeSize, { class: 'is-collapsed' }, { fold: true }),
            ])
          }
        }
      }
      return next
    },
  },
  props: {
    decorations(state) {
      const folded = foldKey.getState(state) ?? DecorationSet.empty
      const widgets: Decoration[] = []
      state.doc.descendants((node, pos) => {
        if (node.type.name !== LIST_ITEM) return true
        if (node.attrs['checked'] != null) {
          const checked = node.attrs['checked'] === true
          widgets.push(
            Decoration.widget(pos + 1, (view) => taskCheckbox(view, pos, checked), {
              side: -2,
              key: `task-${pos}-${String(checked)}`,
              ignoreSelection: true,
            }),
          )
        }
        if (!hasChildList(node)) return true
        const collapsed = foldedAt(folded, pos) != null
        widgets.push(
          Decoration.widget(pos + 1, (view) => toggleButton(view, pos, collapsed), {
            side: -1,
            key: `fold-${pos}-${String(collapsed)}`,
            ignoreSelection: true,
          }),
        )
        return true
      })
      return DecorationSet.create(state.doc, [...folded.find(), ...widgets])
    },
  },
})

/* ------------------------------------------------------------------ keymap */

/**
 * リスト内では preset の Tab (sink/lift) に譲り、テーブル内ではセル移動に譲る。
 * それ以外では **true を返して握り潰す** — Tab でフォーカスがエディタの外へ飛ぶのを防ぐ。
 */
const swallowTabOutsideList: Command = (state) => listItemDepth(state) === null && !inTable(state)

export const outlineKeymap = $prose(() =>
  keymap({
    Tab: swallowTabOutsideList,
    'Shift-Tab': swallowTabOutsideList,
    'Mod-.': toggleFold,
    'Mod-Shift-8': setListKind('bullet'),
    'Mod-Shift-7': setListKind('ordered'),
    'Mod-Shift-9': setListKind('task'),
    'Mod-Shift-Enter': toggleTaskChecked,
  }),
)

export const outlineFold = $prose(() => foldPlugin)

export const outline = [outlineKeymap, outlineFold].flat()
