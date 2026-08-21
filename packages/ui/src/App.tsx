import { useCallback, useEffect, useState, type JSX } from 'react'
import { Editor } from './editor/Editor'
import { listNotes, readNote, writeNote } from './api'

export function App(): JSX.Element {
  const [paths, setPaths] = useState<string[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listNotes().then(setPaths).catch((e: unknown) => setError(String(e)))
  }, [])

  const open = useCallback((path: string) => {
    setCurrent(path)
    setContent(null)
    readNote(path).then(setContent).catch((e: unknown) => setError(String(e)))
  }, [])

  const save = useCallback(
    (next: string) => {
      if (current === null) return
      writeNote(current, next)
        .then(() => setContent(next))
        .catch((e: unknown) => setError(String(e)))
    },
    [current],
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Loamium</h1>
        {error !== null && <p className="error">{error}</p>}
        <ul>
          {paths.map((p) => (
            <li key={p}>
              <button type="button" aria-current={p === current} onClick={() => open(p)}>
                {p}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main">
        {current === null ? (
          <p className="empty">ノートを選んでください</p>
        ) : content === null ? (
          <p className="empty">読み込み中…</p>
        ) : (
          <Editor value={content} onSave={save} />
        )}
      </main>
    </div>
  )
}
