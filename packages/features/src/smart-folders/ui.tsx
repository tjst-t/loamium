import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { FolderSearch, Plus, Trash2, X } from 'lucide-react'
import { apiJson } from '@loamium/ui/src/api'
import { defineUiFeature, useShell } from '@loamium/ui/src/feature'
import { smartFoldersApi, type SmartFolder, type SmartFolderResult } from './contract'

/**
 * スマートフォルダ (task #25)。
 *
 * サイドバーの一覧と、開いたときの画面。**選んでいるフォルダはこの機能が持つ**
 * (機能の内部状態をシェルに持たせない)。中身は dataview と同じクエリ。
 */

let folders: SmartFolder[] = []
let opened: string | null = null
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

async function refresh(): Promise<void> {
  try {
    folders = (await apiJson<{ folders: SmartFolder[] }>(smartFoldersApi.list())).folders
    publish()
  } catch {
    // 取れないだけ。他の機能は動く
  }
}

function open(id: string | null): void {
  opened = id
  publish()
}

function useFolders(): SmartFolder[] {
  const list = useSyncExternalStore(subscribe, () => folders)
  useEffect(() => { void refresh() }, [])
  return list
}

const useOpened = (): string | null => useSyncExternalStore(subscribe, () => opened)

/** サイドバーの一覧 */
function FolderList(): JSX.Element | null {
  const list = useFolders()
  const current = useOpened()
  const { dismiss, openFeatureView } = useShell()
  const [adding, setAdding] = useState(false)

  return (
    <section>
      <h2 className="section-label">
        <FolderSearch size={12} /> スマートフォルダ
        <button
          type="button"
          className="icon-button is-small"
          aria-label="スマートフォルダを作る"
          title="スマートフォルダを作る"
          onClick={() => { setAdding((value) => !value) }}
        >
          {adding ? <X size={14} /> : <Plus size={14} />}
        </button>
      </h2>
      {adding && <FolderForm onDone={() => { setAdding(false); void refresh() }} />}
      <ul className="smart-list">
        {list.map((folder) => (
          <li key={folder.id}>
            <button
              type="button"
              className="smart-folder"
              aria-current={folder.id === current}
              onClick={() => { open(folder.id); openFeatureView('smartFolders'); dismiss() }}
            >
              {folder.name}
            </button>
          </li>
        ))}
      </ul>
      {list.length === 0 && !adding && <p className="panel-note">まだありません</p>}
    </section>
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

/** 開いたときの画面 */
function FolderView(): JSX.Element {
  const id = useOpened()
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
  // ノートを開いていないときだけ前に出る (ノートを開いたら本文が主役)
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
