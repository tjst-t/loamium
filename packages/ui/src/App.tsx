import { useCallback, useEffect, useState, type JSX } from 'react'
import { Editor } from './editor/Editor'
import { FileTree } from './components/FileTree'
import {
  ApiError, createFolder, createNote, fetchTree, movePath, readNote, removePath, writeNote,
  type TreeNode,
} from './api'

export function App(): JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 失敗しても画面は生かす。理由はそのまま出す (409「すでに存在します」等) */
  const run = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    try {
      setError(null)
      await fn()
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setTree(await fetchTree())
  }, [])

  useEffect(() => { void run(refresh) }, [run, refresh])

  const open = useCallback((path: string) => {
    void run(async () => {
      setCurrent(path)
      setContent(null)
      setContent(await readNote(path))
    })
  }, [run])

  const save = useCallback((next: string) => {
    if (current === null) return
    void run(async () => {
      await writeNote(current, next)
      setContent(next)
    })
  }, [current, run])

  const onCreate = useCallback((parent: string, name: string, kind: 'folder' | 'note') => {
    const path = parent === '' ? name : `${parent}/${name}`
    void run(async () => {
      if (kind === 'folder') {
        await createFolder(path)
      } else {
        const notePath = path.endsWith('.md') ? path : `${path}.md`
        await createNote(notePath, `# ${name.replace(/\.md$/, '')}\n`)
        await refresh()
        open(notePath)
        return
      }
      await refresh()
    })
  }, [open, refresh, run])

  const onRename = useCallback((from: string, to: string) => {
    void run(async () => {
      await movePath(from, to)
      await refresh()
      // 開いているノート (またはその親フォルダ) が動いたら追従する
      if (current === from) setCurrent(to)
      else if (current !== null && current.startsWith(`${from}/`)) setCurrent(to + current.slice(from.length))
    })
  }, [current, refresh, run])

  const onDelete = useCallback((node: TreeNode) => {
    const message = node.type === 'folder'
      ? `フォルダ「${node.name}」を中身ごと削除します。よろしいですか?`
      : `「${node.name}」を削除します。よろしいですか?`
    if (!window.confirm(message)) return
    void run(async () => {
      await removePath(node.path, node.type)
      await refresh()
      if (current !== null && (current === node.path || current.startsWith(`${node.path}/`))) {
        setCurrent(null)
        setContent(null)
      }
    })
  }, [current, refresh, run])

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Loamium</h1>
        {error !== null && <p className="error">{error}</p>}
        <FileTree
          tree={tree}
          currentPath={current}
          onOpen={open}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
        />
      </aside>
      <main className="main">
        {current === null ? (
          <p className="empty">ノートを選んでください</p>
        ) : content === null ? (
          <p className="empty">読み込み中…</p>
        ) : (
          <Editor key={current} value={content} onSave={save} />
        )}
      </main>
    </div>
  )
}
