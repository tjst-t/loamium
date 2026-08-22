import { useCallback, useEffect, useState, type JSX } from 'react'
import { Editor } from './editor/Editor'
import { InfoPanel } from './components/InfoPanel'
import { matchesKeys, ShellProvider, type Shell } from './feature'
import { editorPlugins, enabledFeatures } from './features'
import { scrollToTextWhenReady } from './scroll-to-text'
import { pathFromSearch, searchParamsFromSearch, useRoute } from './route'
import { forgetNoteViewState, renameNoteViewState } from './editor/view-state'
import {
  ApiError, createFolder, createNote, fetchJournal, fetchServerFeatures, fetchTags, fetchTree,
  listNotes, movePath, readNote, removePath, writeNote, type TreeNode,
} from './api'

const PANEL_KEY = 'loamium.panel-open'

export function App(): JSX.Element {
  // 開いているノートは URL が持つ。戻る/進むがそのままノート履歴になる (task #2)
  const { path: current, search, navigate, navigateSearch } = useRoute()
  const [tree, setTree] = useState<TreeNode[]>([])
  /** vault の全ノート。`[[リンク]]` の解決と補完に渡す */
  const [notes, setNotes] = useState<string[]>([])
  /** vault のタグ。`#` の補完に渡す */
  const [tags, setTags] = useState<string[]>([])
  /**
   * サーバーに登録されている機能。**これが UI 機能の有効・無効を決める** (取得前は null)。
   * `app.ts` から機能を外すと、リロードで UI 側も消える
   */
  const [serverFeatures, setServerFeatures] = useState<string[] | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
    const [nextTree, nextNotes, nextTags] = await Promise.all([fetchTree(), listNotes(), fetchTags()])
    setTree(nextTree)
    setNotes(nextNotes)
    setTags(nextTags.map((entry) => entry.tag))
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
    fetchServerFeatures().then(setServerFeatures).catch(() => { setServerFeatures(null) })
    void run(refresh)
    if (pathFromSearch(window.location.search) === null && searchParamsFromSearch(window.location.search) === null) {
      openJournal(undefined, { replace: true })
    }
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

  // ESC で選択解除と blur。エディタ内で既に処理済み (ノードを抜ける等) なら触らない。
  // ⚠️ 機能のコマンドとは別扱い: これはシェル自身の挙動 (どの機能にも属さない)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body) active.blur()
      window.getSelection()?.removeAllRanges()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [])

  /** 検索結果を開く。本文が描画されてから該当箇所までスクロールする */
  const openHit = useCallback((path: string, needle: string) => {
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

  /** 詳細検索ページを開く (task #8) */
  const openSearchPage = useCallback(() => {
    navigateSearch({ q: '', tag: '', folder: '' }, { replace: false })
  }, [navigateSearch])

  /** タグをクリックしたら詳細検索へ (task #8 / #9) */
  const openTag = useCallback((tag: string) => {
    navigateSearch({ q: '', tag, folder: '' }, { replace: false })
  }, [navigateSearch])

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

  const features = enabledFeatures(serverFeatures)
  const shell: Shell = {
    notes,
    tags,
    tree,
    currentPath: current,
    search,
    openNote: open,
    openHit,
    openTag,
    openSearch: openSearchPage,
    setSearch: (next) => { navigateSearch(next) },
    openJournal,
    createEntry: onCreate,
    renameEntry: onRename,
    deleteEntry: onDelete,
  }
  const view = features.find((feature) => feature.view?.match({ path: current, search }) === true)
  const commands = features.flatMap((feature) => feature.commands?.(shell) ?? [])

  /**
   * 機能が宣言したキーバインドを張る。**シェルは何のキーかを知らない。**
   * 入力欄にいても効かせる (パレットは打鍵中に開きたい)。
   */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const hit = commands.find((command) => command.keys !== undefined && matchesKeys(command.keys, e))
      if (hit === undefined) return
      e.preventDefault()
      hit.run()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  })

  return (
    <ShellProvider value={shell}>
    <div className={`app${panelOpen ? ' panel-open' : ''}`}>
      <aside className="sidebar">
        <h1>Loamium</h1>
        {error !== null && <p className="error">{error}</p>}
        {features.map((feature) => (
          feature.sidebarItem === undefined
            ? null
            : <div key={feature.name}>{feature.sidebarItem()}</div>
        ))}
      </aside>
      <main className="main">
        {view !== undefined ? (
          view.view?.render()
        ) : current === null ? (
          <p className="empty">ノートを選んでください</p>
        ) : content === null ? (
          <p className="empty">読み込み中…</p>
        ) : (
          <Editor
            key={current}
            path={current}
            notes={notes}
            tags={tags}
            value={content}
            onSave={save}
            onOpenLink={open}
            onCreateLink={createFromLink}
            onOpenTag={openTag}
            beforePreset={editorPlugins(features, 'before-preset')}
            afterPreset={editorPlugins(features, 'after-preset')}
          />
        )}
      </main>
      <InfoPanel
        open={panelOpen}
        onToggle={() => { setPanelOpen((v) => !v) }}
        path={current}
        content={content}
        features={features}
      />
      {features.map((feature) => (
        feature.overlay === undefined ? null : <div key={feature.name}>{feature.overlay()}</div>
      ))}
    </div>
    </ShellProvider>
  )
}
