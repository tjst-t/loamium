import { useEffect, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderPlus, FilePlus, MoreHorizontal, Pencil, Trash2,
} from 'lucide-react'
import type { TreeNode } from '../api'

export interface FileTreeProps {
  tree: TreeNode[]
  currentPath: string | null
  onOpen: (path: string) => void
  /** parent は vault 相対のフォルダパス (ルートは '') */
  onCreate: (parent: string, name: string, kind: 'folder' | 'note') => void
  onRename: (from: string, to: string) => void
  onDelete: (node: TreeNode) => void
}

/** 下書き行 (新規作成の入力欄) をどこに出すか */
interface Draft { parent: string; kind: 'folder' | 'note' }

/** 開いているメニュー。位置はビューポート座標 (position: fixed で出す) */
interface MenuState { node: TreeNode; x: number; y: number }

/** メニューの幅 (px)。ボタン右端に右揃えするので JS 側でも参照する */
const MENU_WIDTH = 200

const joinPath = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`)
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
/** 拡張子はユーザーに強制させない。`.md` が無ければ足す */
const withMd = (name: string): string => (name.endsWith('.md') ? name : `${name}.md`)

/**
 * サイドバーのフォルダツリー。
 * 作成・リネームは行内の入力欄で完結させる (別モーダルを開かない)。
 */
export function FileTree(props: FileTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  // メニューの外側クリック・Escape・スクロールで閉じる
  useEffect(() => {
    if (menu === null) return undefined
    const close = (): void => { setMenu(null) }
    const onKey = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape') close() }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }

  const startDraft = (parent: string, kind: 'folder' | 'note'): void => {
    setExpanded((prev) => new Set(prev).add(parent))
    setRenaming(null)
    setDraft({ parent, kind })
  }

  const commitDraft = (name: string): void => {
    if (draft !== null && name !== '') props.onCreate(draft.parent, name, draft.kind)
    setDraft(null)
  }

  const commitRename = (node: TreeNode, name: string): void => {
    const to = joinPath(parentOf(node.path), node.type === 'note' ? withMd(name) : name)
    if (name !== '' && to !== node.path) props.onRename(node.path, to)
    setRenaming(null)
  }

  /** ケバブボタンからも右クリックからも同じメニューを出す */
  const openMenu = (e: MouseEvent, node: TreeNode): void => {
    e.preventDefault()
    e.stopPropagation()
    // ボタン起点ならその左下、右クリックならカーソル位置
    const el = e.currentTarget as HTMLElement
    const anchor = el.tagName === 'BUTTON' ? el.getBoundingClientRect() : null
    setDraft(null)
    setRenaming(null)
    setMenu({
      node,
      x: anchor === null ? e.clientX : anchor.right - MENU_WIDTH,
      y: anchor === null ? e.clientY : anchor.bottom + 2,
    })
  }

  const menuItems = (node: TreeNode): { label: string; icon: JSX.Element; run: () => void }[] => [
    ...(node.type === 'folder'
      ? [
          {
            label: 'このフォルダに新規ノート',
            icon: <FilePlus size={14} />,
            run: () => { startDraft(node.path, 'note') },
          },
          {
            label: 'このフォルダに新規フォルダ',
            icon: <FolderPlus size={14} />,
            run: () => { startDraft(node.path, 'folder') },
          },
        ]
      : []),
    { label: '名前の変更', icon: <Pencil size={14} />, run: () => { setDraft(null); setRenaming(node.path) } },
    { label: '削除', icon: <Trash2 size={14} />, run: () => { props.onDelete(node) } },
  ]

  const renderNodes = (nodes: TreeNode[], parent: string, depth: number): JSX.Element[] => {
    const rows: JSX.Element[] = []
    for (const node of nodes) {
      const isOpen = expanded.has(node.path)
      rows.push(
        <li
          key={node.path}
          className="tree-row"
          style={{ paddingLeft: `${depth * 12}px` }}
          onContextMenu={(e) => { openMenu(e, node) }}
        >
          {renaming === node.path ? (
            <NameInput
              initial={node.name.replace(/\.md$/, '')}
              onCommit={(name) => { commitRename(node, name) }}
              onCancel={() => { setRenaming(null) }}
            />
          ) : (
            <>
              <button
                type="button"
                className="tree-label"
                aria-current={node.path === props.currentPath}
                onClick={() => { node.type === 'folder' ? toggle(node.path) : props.onOpen(node.path) }}
              >
                {node.type === 'folder'
                  ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
                  : <span className="tree-spacer" />}
                {node.type === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
                <span className="tree-name">{node.name}</span>
              </button>
              {/* 操作は 1 つに畳む。4 個並べるとサイドバー幅を食って名前が潰れる */}
              <span className="tree-actions">
                <IconButton
                  label={`${node.name} の操作`}
                  active={menu?.node.path === node.path}
                  onClick={(e) => { openMenu(e, node) }}
                >
                  <MoreHorizontal size={16} />
                </IconButton>
              </span>
            </>
          )}
        </li>,
      )
      if (node.type === 'folder' && isOpen) {
        rows.push(...renderDraft(node.path, depth + 1))
        rows.push(...renderNodes(node.children ?? [], node.path, depth + 1))
      }
    }
    return rows
  }

  const renderDraft = (parent: string, depth: number): JSX.Element[] =>
    draft !== null && draft.parent === parent
      ? [
          <li key={`draft:${parent}`} className="tree-row" style={{ paddingLeft: `${depth * 12}px` }}>
            {draft.kind === 'folder' ? <Folder size={14} /> : <FileText size={14} />}
            <NameInput
              initial=""
              placeholder={draft.kind === 'folder' ? 'フォルダ名' : 'ノート名'}
              onCommit={commitDraft}
              onCancel={() => { setDraft(null) }}
            />
          </li>,
        ]
      : []

  return (
    <div className="tree">
      <div className="tree-toolbar">
        <span className="tree-toolbar-title">ノート</span>
        <IconButton label="新規ノート" onClick={() => { startDraft('', 'note') }}><FilePlus size={16} /></IconButton>
        <IconButton label="新規フォルダ" onClick={() => { startDraft('', 'folder') }}><FolderPlus size={16} /></IconButton>
      </div>
      <ul className="tree-list">
        {renderDraft('', 0)}
        {renderNodes(props.tree, '', 0)}
      </ul>
      {menu !== null && (
        <ul
          className="tree-menu"
          role="menu"
          aria-label={`${menu.node.name} の操作`}
          style={{ left: `${Math.max(4, menu.x)}px`, top: `${menu.y}px`, width: `${MENU_WIDTH}px` }}
          // メニュー内の pointerdown で閉じないようにする (項目の click まで生かす)
          onPointerDown={(e) => { e.stopPropagation() }}
        >
          {menuItems(menu.node).map((item) => (
            <li key={item.label}>
              <button
                type="button"
                role="menuitem"
                className="tree-menu-item"
                onClick={() => { setMenu(null); item.run() }}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function IconButton(
  props: { label: string; onClick: (e: MouseEvent) => void; children: JSX.Element; active?: boolean },
): JSX.Element {
  return (
    <button
      type="button"
      className="icon-button"
      title={props.label}
      aria-label={props.label}
      aria-expanded={props.active ?? false}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** 行内の名前入力。Enter で確定 / Escape で取り消し (ノードから抜ける挙動を最初から用意する) */
function NameInput(
  props: { initial: string; placeholder?: string; onCommit: (name: string) => void; onCancel: () => void },
): JSX.Element {
  const [value, setValue] = useState(props.initial)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') props.onCommit(value.trim())
    else if (e.key === 'Escape') props.onCancel()
  }
  return (
    <input
      className="tree-input"
      autoFocus
      value={value}
      placeholder={props.placeholder ?? ''}
      aria-label={props.placeholder ?? '名前'}
      onChange={(e) => { setValue(e.target.value) }}
      onKeyDown={onKeyDown}
      onBlur={() => { props.onCommit(value.trim()) }}
    />
  )
}
