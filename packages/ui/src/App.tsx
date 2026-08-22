import { useCallback, useEffect, useState, type JSX } from 'react'
import { Editor } from './editor/Editor'
import { FileTree } from './components/FileTree'
import { InfoPanel } from './components/InfoPanel'
import { JournalCard } from './components/JournalCard'
import { SearchPalette } from './components/SearchPalette'
import { scrollToTextWhenReady } from './scroll-to-text'
import { pathFromSearch, useRoute } from './route'
import { forgetNoteViewState, renameNoteViewState } from './editor/view-state'
import {
  ApiError, createFolder, createNote, fetchJournal, fetchTree, listNotes, movePath, readNote,
  removePath, writeNote, type TreeNode,
} from './api'

/** `journals/YYYY-MM-DD.md` から日付を取り出す。ジャーナル以外なら null */
const journalDateOf = (path: string | null): string | null =>
  (path === null ? null : /^journals\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1] ?? null)

const todayISO = (): string => {
  const n = new Date()
  return `${n.getFullYear()}-${`${n.getMonth() + 1}`.padStart(2, '0')}-${`${n.getDate()}`.padStart(2, '0')}`
}

const PANEL_KEY = 'loamium.panel-open'

export function App(): JSX.Element {
  // 開いているノートは URL が持つ。戻る/進むがそのままノート履歴になる (task #2)
  const { path: current, navigate } = useRoute()
  const [tree, setTree] = useState<TreeNode[]>([])
  /** vault の全ノート。`[[リンク]]` の解決と補完に渡す */
  const [notes, setNotes] = useState<string[]>([])
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 本文を強制的に読み直すための世代番号 (リネームでリンクが書き換わったときなど) */
  const [reloadToken, setReloadToken] = useState(0)
  const [panelOpen, setPanelOpen] = useState(() => window.localStorage.getItem(PANEL_KEY) !== 'false')
  /** 開いた直後に本文中で光らせる語 (検索から飛んできたとき) */
  const [pendingNeedle, setPendingNeedle] = useState<string | null>(null)

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
    const [nextTree, nextNotes] = await Promise.all([fetchTree(), listNotes()])
    setTree(nextTree)
    setNotes(nextNotes)
  }, [])

  /** ジャーナルを開く。遅延生成されたらツリーを引き直す */
  const openJournal = useCallback((date?: string, options?: { replace?: boolean }) => {
    void run(async () => {
      const journal = await fetchJournal(date)
      navigate(journal.path, options)
      if (journal.created) await refresh()
    })
  }, [navigate, refresh, run])

  // 起動時: URL にノートが載っていればそれを開く。無ければ今日のジャーナルへ着地する
  // (VISION: ジャーナル中心のワークフロー)。着地は履歴に積まない
  useEffect(() => {
    void run(refresh)
    if (pathFromSearch(window.location.search) === null) openJournal(undefined, { replace: true })
    // 起動時に一度だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const open = useCallback((path: string) => { navigate(path) }, [navigate])

  // URL のノートを読む。戻る/進むで来たときもここを通る
  useEffect(() => {
    if (current === null) {
      setContent(null)
      return undefined
    }
    let live = true
    setContent(null)
    void run(async () => {
      const text = await readNote(current)
      if (live) setContent(text)
    })
    return () => { live = false }
  }, [current, reloadToken, run])

  // Cmd/Ctrl+K で検索パレット。入力欄にいても開けるようにする
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // ESC で選択解除と blur。エディタ内で既に処理済み (ノードを抜ける等) なら触らない
      if (e.key === 'Escape' && !e.defaultPrevented) {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
        window.getSelection()?.removeAllRanges()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [])

  /** 検索結果を開く。本文が描画されてから該当箇所までスクロールする */
  const openHit = useCallback((path: string, needle: string) => {
    setPaletteOpen(false)
    setPendingNeedle(needle)
    if (path === current) return // 同じノート内の移動は再読み込み不要
    open(path)
  }, [current, open])

  useEffect(() => {
    if (pendingNeedle === null || content === null) return undefined
    return scrollToTextWhenReady(pendingNeedle)
  }, [pendingNeedle, content])

  /**
   * 壊れリンクをクリックしたら、その名前でノートを作って開く (task #4)。
   * 置き場所は**リンク元と同じフォルダ**。`[[フォルダ/名前]]` と書いてあればそのパス。
   */
  const createFromLink = useCallback((target: string) => {
    const clean = target.trim().replace(/\.md$/i, '')
    const dir = current !== null && current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''
    const path = clean.includes('/') || dir === '' ? `${clean}.md` : `${dir}/${clean}.md`
    void run(async () => {
      const title = clean.slice(clean.lastIndexOf('/') + 1)
      await createNote(path, `# ${title}\n`)
      await refresh()
      navigate(path)
    })
  }, [current, navigate, refresh, run])

  // 情報パネルの開閉は憶えておく (毎回開き直させない)
  useEffect(() => { window.localStorage.setItem(PANEL_KEY, String(panelOpen)) }, [panelOpen])

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
      renameNoteViewState(from, to)
      // 移動で本文中の [[リンク]] がサーバー側で書き換わることがある。
      // 開いているノートが対象だと画面が古いままになるので読み直す
      setReloadToken((v) => v + 1)
      // 開いているノート (またはその親フォルダ) が動いたら追従する。
      // 履歴には積まない — 戻ると存在しないパスに着地してしまうため
      if (current === from) navigate(to, { replace: true })
      else if (current !== null && current.startsWith(`${from}/`)) {
        navigate(to + current.slice(from.length), { replace: true })
      }
    })
  }, [current, navigate, refresh, run])

  const onDelete = useCallback((node: TreeNode) => {
    const message = node.type === 'folder'
      ? `フォルダ「${node.name}」を中身ごと削除します。よろしいですか?`
      : `「${node.name}」を削除します。よろしいですか?`
    if (!window.confirm(message)) return
    void run(async () => {
      await removePath(node.path, node.type)
      await refresh()
      forgetNoteViewState(node.path)
      if (current !== null && (current === node.path || current.startsWith(`${node.path}/`))) {
        navigate(null, { replace: true })
      }
    })
  }, [current, navigate, refresh, run])

  // ジャーナルを開いていればその日付、そうでなければ今日を指しておく
  const journalDate = journalDateOf(current)

  return (
    <div className={`app${panelOpen ? ' panel-open' : ''}`}>
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
          <Editor
            key={current}
            path={current}
            notes={notes}
            value={content}
            onSave={save}
            onOpenLink={open}
            onCreateLink={createFromLink}
          />
        )}
      </main>
      <InfoPanel
        open={panelOpen}
        onToggle={() => { setPanelOpen((v) => !v) }}
        path={current}
        content={content}
        onOpen={open}
      />
      <SearchPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false) }}
        onPick={openHit}
      />
    </div>
  )
}
