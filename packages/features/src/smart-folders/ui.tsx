import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { ChevronDown, ChevronRight, FileText, FolderSearch, Plus, Trash2, X } from 'lucide-react'
import { apiJson } from '@loamium/ui/src/api'
import { defineUiFeature, useShell } from '@loamium/ui/src/feature'
import { smartFoldersApi, type SmartFolder, type SmartFolderResult } from './contract'

/**
 * スマートフォルダ (task #25)。
 *
 * **普通のフォルダと同じ操作語彙で開ける**: `▸` で展開して中身をその場に出し、
 * 名前を押すと一覧の画面になる。ただし**物理ツリーには混ぜない** — ツリーの行は
 * 「ディスクにこう置かれている」の写像で、移動やドラッグはパスを意味する。
 * 条件で集まるものを同じ見た目で混ぜると、その意味が定義できなくなる。
 *
 * 中身は dataview と同じクエリ。選んでいるフォルダはこの機能が持つ
 * (何を見せるかは機能、画面を前に出しているかはシェル)。
 */

let folders: SmartFolder[] = []
let opened: string | null = null
/** 展開しているフォルダと、その中身 */
const expanded = new Set<string>()
const contents = new Map<string, SmartFolderResult>()

const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

async function refresh(): Promise<void> {
  try {
    folders = (await apiJson<{ folders: SmartFolder[] }>(smartFoldersApi.list())).folders
    contents.clear()
    publish()
  } catch {
    // 取れないだけ。他の機能は動く
  }
}

async function load(id: string): Promise<void> {
  try {
    contents.set(id, await apiJson<SmartFolderResult>(smartFoldersApi.run(id)))
  } catch {
    // 下で「読めません」を出す
  }
  publish()
}

function toggle(id: string): void {
  if (expanded.has(id)) expanded.delete(id)
  else {
    expanded.add(id)
    // 開くたびに数え直す (索引を持たないので、常にいまの vault が出る)
    void load(id)
  }
  publish()
}

function open(id: string | null): void {
  opened = id
  publish()
}

const useStore = <T,>(read: () => T): T => useSyncExternalStore(subscribe, read)

/** サイドバーの一覧。フォルダのように開ける */
function FolderList(): JSX.Element {
  const list = useStore(() => folders)
  const current = useStore(() => opened)
  const { dismiss, openFeatureView, openNote, currentPath } = useShell()
  const [adding, setAdding] = useState(false)
  useEffect(() => { void refresh() }, [])

  return (
    <section>
      <h2 className="section-label">
        <FolderSearch size={12} /> スマートフォルダ
        <button
          type="button"
          className="icon-button is-small"
          aria-label={adding ? '作るのをやめる' : 'スマートフォルダを作る'}
          title={adding ? '作るのをやめる' : 'スマートフォルダを作る'}
          onClick={() => { setAdding((value) => !value) }}
        >
          {adding ? <X size={14} /> : <Plus size={14} />}
        </button>
      </h2>
      {adding && <FolderForm onDone={() => { setAdding(false); void refresh() }} />}
      <ul className="tree-list smart-tree">
        {list.map((folder) => (
          <SmartRow
            key={folder.id}
            folder={folder}
            current={current}
            currentPath={currentPath}
            onOpenView={() => { open(folder.id); openFeatureView('smartFolders'); dismiss() }}
            onOpenNote={(path) => { openNote(path) }}
          />
        ))}
      </ul>
      {list.length === 0 && !adding && <p className="panel-note">まだありません</p>}
    </section>
  )
}

function SmartRow({ folder, current, currentPath, onOpenView, onOpenNote }: {
  folder: SmartFolder
  current: string | null
  currentPath: string | null
  onOpenView: () => void
  onOpenNote: (path: string) => void
}): JSX.Element {
  const isOpen = useStore(() => expanded.has(folder.id))
  const found = useStore(() => contents.get(folder.id))

  return (
    <li>
      <div className="tree-row">
        <button
          type="button"
          className="tree-label"
          aria-current={folder.id === current}
          aria-expanded={isOpen}
          onClick={onOpenView}
        >
          <span
            className="tree-twist"
            role="presentation"
            onClick={(event) => { event.stopPropagation(); toggle(folder.id) }}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <FolderSearch size={14} />
          <span className="tree-name">{folder.name}</span>
          {isOpen && found?.result !== undefined && (
            <span className="tree-count">{found.result.rows.length}</span>
          )}
        </button>
      </div>
      {isOpen && (
        <ul className="tree-list is-nested">
          {found === undefined && <li className="panel-note">数えています…</li>}
          {found?.error !== undefined && <li className="panel-note is-flag">{found.error}</li>}
          {found?.result?.rows.map((row) => (
            <li key={`${row.path}:${String(row.task?.line ?? 0)}`}>
              <div className="tree-row">
                <button
                  type="button"
                  className="tree-label"
                  aria-current={row.path === currentPath}
                  onClick={() => { onOpenNote(row.path) }}
                  title={row.path}
                >
                  <span className="tree-spacer" />
                  <FileText size={14} />
                  <span className="tree-name">{row.task?.text ?? row.title}</span>
                </button>
              </div>
            </li>
          ))}
          {found?.result?.rows.length === 0 && <li className="panel-note">当てはまるものはありません</li>}
        </ul>
      )}
    </li>
  )
}

/** 作る / 直すフォーム。クエリは dataview と同じ文字列 */
function FolderForm({ folder, onDone }: { folder?: SmartFolder; onDone: () => void }): JSX.Element {
  const [name, setName] = useState(folder?.name ?? '')
  const [query, setQuery] = useState(folder?.query ?? 'LIST FROM #')
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(() => {
    apiJson<SmartFolder>(smartFoldersApi.save(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(folder === undefined ? {} : { id: folder.id }), name, query }),
    }).then(onDone, (cause: unknown) => {
      // 壊れたクエリは保存されない。理由をその場に出す
      setError(cause instanceof Error ? cause.message : '保存できませんでした')
    })
  }, [folder, name, query, onDone])

  return (
    <div className="smart-form">
      <input
        className="smart-input"
        value={name}
        placeholder="名前"
        aria-label="スマートフォルダの名前"
        onChange={(e) => { setName(e.target.value) }}
      />
      <textarea
        className="smart-input is-query"
        value={query}
        rows={2}
        aria-label="クエリ"
        onChange={(e) => { setQuery(e.target.value) }}
      />
      {error !== null && <p className="panel-note is-flag">{error}</p>}
      <div className="smart-form-actions">
        <button type="button" className="smart-save" onClick={save} disabled={name.trim() === ''}>
          保存
        </button>
      </div>
    </div>
  )
}

/** 名前を押したときの画面 (件数が多いとき・条件を直すとき) */
function FolderView(): JSX.Element {
  const id = useStore(() => opened)
  const { openNote, openFeatureView } = useShell()
  const [found, setFound] = useState<SmartFolderResult | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (id === null) return undefined
    let live = true
    setFound(null)
    setEditing(false)
    apiJson<SmartFolderResult>(smartFoldersApi.run(id))
      .then((body) => { if (live) setFound(body) }, () => { /* 下で「読めません」を出す */ })
    return () => { live = false }
  }, [id])

  const remove = useCallback(() => {
    if (id === null || !window.confirm('このスマートフォルダを消します。ノートは消えません。')) return
    void apiJson(smartFoldersApi.remove(id), { method: 'DELETE' }).then(() => {
      open(null)
      openFeatureView(null)
      void refresh()
    })
  }, [id, openFeatureView])

  if (id === null) return <p className="empty">スマートフォルダを選んでください</p>

  return (
    <div className="smart-page">
      <header className="smart-head">
        <h1 className="smart-title">{found?.folder.name ?? id}</h1>
        <div className="smart-head-actions">
          <button type="button" className="smart-action" onClick={() => { setEditing((value) => !value) }}>
            {editing ? '閉じる' : '条件を直す'}
          </button>
          <button type="button" className="smart-action is-danger" onClick={remove}>
            <Trash2 size={13} /> 削除
          </button>
          <button type="button" className="smart-action" onClick={() => { open(null); openFeatureView(null) }}>
            閉じる
          </button>
        </div>
      </header>
      {/* 条件はディスク上の文字列そのものなので等幅で見せる */}
      {editing && found !== null
        ? (
          <FolderForm
            folder={found.folder}
            onDone={() => {
              setEditing(false)
              void refresh()
              apiJson<SmartFolderResult>(smartFoldersApi.run(id)).then(setFound, () => { /* そのまま */ })
            }}
          />
          )
        : <p className="smart-query">{found?.folder.query ?? ''}</p>}

      {found === null && <p className="panel-note">数えています…</p>}
      {found?.error !== undefined && <p className="panel-note is-flag">{found.error}</p>}
      {found?.result !== undefined && (
        <>
          <p className="smart-count">{found.result.rows.length} 件</p>
          <ul className="smart-results">
            {found.result.rows.map((row) => (
              <li key={`${row.path}:${String(row.task?.line ?? 0)}`}>
                <button type="button" className="smart-result" onClick={() => { openNote(row.path) }}>
                  <span className="smart-result-title">{row.task?.text ?? row.title}</span>
                  <span className="smart-result-path">{row.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default defineUiFeature({
  name: 'smartFolders',
  requires: 'smartFolders',
  sidebarItem: () => <FolderList />,
  view: {
    match: (route) => route.feature === 'smartFolders' && opened !== null,
    render: () => <FolderView />,
  },
  commands: (shell) => [
    {
      id: 'smart-folders.close',
      title: 'スマートフォルダを閉じる',
      run: () => { open(null); shell.openFeatureView(null); shell.dismiss() },
    },
  ],
})
