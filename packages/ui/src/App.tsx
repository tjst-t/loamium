import { useCallback, useEffect, useState, type JSX } from 'react'
import { Editor } from './editor/Editor'
import { FileTree } from './components/FileTree'
import { JournalCard } from './components/JournalCard'
import {
  ApiError, createFolder, createNote, fetchJournal, fetchTree, movePath, readNote, removePath,
  writeNote, type TreeNode,
} from './api'

/** `journals/YYYY-MM-DD.md` から日付を取り出す。ジャーナル以外なら null */
const journalDateOf = (path: string | null): string | null =>
  (path === null ? null : /^journals\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1] ?? null)

const todayISO = (): string => {
  const n = new Date()
  return `${n.getFullYear()}-${`${n.getMonth() + 1}`.padStart(2, '0')}-${`${n.getDate()}`.padStart(2, '0')}`
}

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

  /** ジャーナルを開く。遅延生成されたらツリーを引き直す */
  const openJournal = useCallback((date?: string) => {
    void run(async () => {
      const journal = await fetchJournal(date)
      setCurrent(journal.path)
      setContent(journal.content)
      if (journal.created) await refresh()
    })
  }, [refresh, run])

  // 起動したら今日のジャーナルに着地する (VISION: ジャーナル中心のワークフロー)
  useEffect(() => {
    void run(refresh)
    openJournal()
  }, [openJournal, refresh, run])

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

  // ジャーナルを開いていればその日付、そうでなければ今日を指しておく
  const journalDate = journalDateOf(current)

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Loamium</h1>
        {error !== null && <p className="error">{error}</p>}
        <JournalCard date={journalDate ?? todayISO()} active={journalDate !== null} onGo={openJournal} />
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
