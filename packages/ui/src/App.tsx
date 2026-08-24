import { Fragment, useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react'
import { Editor } from './editor/Editor'
import { InfoPanel } from './components/InfoPanel'
import { Resizer } from './components/Resizer'
import { AppBar } from './components/AppBar'
import { Drawer } from './components/Drawer'
import { BREAKPOINT, useIsMobile } from './use-media'
import { matchesKeys, ShellProvider, type Shell } from './feature'
import { editorPlugins, enabledFeatures } from './features'
import { scrollToTextWhenReady } from './scroll-to-text'
import { pathFromSearch, searchParamsFromSearch, useRoute } from './route'
import { forgetNoteViewState, renameNoteViewState } from './editor/view-state'
import {
  ApiError, createFolder, createNote, fetchJournal, fetchServerFeatures, fetchTags, fetchTree,
  fileUrl, listNotes, movePath, readNote, removePath, writeNote, type TreeNode,
} from './api'

const PANEL_KEY = 'loamium.panel-open'
/** ペインの幅は憶えておく (毎回引き直させない) */
const SIDEBAR_W_KEY = 'loamium.sidebar-width'
const PANEL_W_KEY = 'loamium.panel-width'
const SIDEBAR_W = { min: 180, max: 460, default: 236 }
const PANEL_W = { min: 200, max: 520, default: 264 }

const storedWidth = (key: string, fallback: number, min: number, max: number): number => {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, min), max) : fallback
}

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
  /** 前に出ている機能の画面 (どの機能か。何を見せるかは機能が持つ) */
  const [featureView, setFeatureView] = useState<string | null>(null)
  /** モバイルのドロワー。**開閉はシェルが持つ** (機能はどこに置かれるかを知らない) */
  const isMobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(
    () => storedWidth(SIDEBAR_W_KEY, SIDEBAR_W.default, SIDEBAR_W.min, SIDEBAR_W.max))
  const [panelWidth, setPanelWidth] = useState(
    () => storedWidth(PANEL_W_KEY, PANEL_W.default, PANEL_W.min, PANEL_W.max))
  const [panelOpen, setPanelOpen] = useState(() => {
    const stored = window.localStorage.getItem(PANEL_KEY)
    // 画面が狭いときは既定で閉じる (本文の場所を先に確保する)
    if (stored === null) return !window.matchMedia(`(max-width: ${String(BREAKPOINT.tablet)}px)`).matches
    return stored !== 'false'
  })
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

  const dismiss = useCallback(() => {
    setNavOpen(false)
    setInfoOpen(false)
  }, [])

  const open = useCallback((path: string) => {
    // 添付 (.md 以外) はノートとして開けない。そのまま配る URL を別タブで見せる
    if (!path.endsWith('.md')) { window.open(fileUrl(path), '_blank', 'noreferrer'); return }
    // ノートを開いたら本文が主役。機能の画面は引っ込める
    setFeatureView(null)
    navigate(path)
    dismiss()
  }, [dismiss, navigate])

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
    setFeatureView(null)
    navigateSearch({ q: '', tag: '', folder: '' }, { replace: false })
    dismiss()
  }, [dismiss, navigateSearch])

  /** タグをクリックしたら詳細検索へ (task #8 / #9) */
  const openTag = useCallback((tag: string) => {
    navigateSearch({ q: '', tag, folder: '' }, { replace: false })
    dismiss()
  }, [dismiss, navigateSearch])

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
    content,
    patchContent: setContent,
    search,
    openNote: open,
    openHit,
    openTag,
    openSearch: openSearchPage,
    openFeatureView: setFeatureView,
    setSearch: (next) => { navigateSearch(next) },
    dismiss,
    openJournal,
    createEntry: onCreate,
    renameEntry: onRename,
    deleteEntry: onDelete,
  }
  const view = features.find((feature) =>
    feature.view?.match({ path: current, search, feature: featureView }) === true)

  /** 左の面の中身。デスクトップではサイドバー、モバイルではドロワーに入る */
  const navContent = (
    <>
      {error !== null && <p className="error">{error}</p>}
      {features.map((feature) => (
        feature.sidebarItem === undefined
          ? null
          : <div className="sidebar-slot" key={feature.name}>{feature.sidebarItem()}</div>
      ))}
    </>
  )
  /** いまどこにいるか (モバイルの上部バーに出す) */
  const title = search !== null
    ? '検索'
    : current === null ? 'Loamium' : current.slice(current.lastIndexOf('/') + 1).replace(/\.md$/i, '')
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
    <div
      className={`app${panelOpen ? ' panel-open' : ''}${isMobile ? ' is-mobile' : ''}`}
      style={{ '--sidebar-w': `${String(sidebarWidth)}px`, '--panel-w': `${String(panelWidth)}px` } as CSSProperties}
    >
      {isMobile && (
        <AppBar
          title={title}
          canOpenInfo={current !== null}
          onOpenNav={() => { setNavOpen(true) }}
          onOpenInfo={() => { setInfoOpen(true) }}
          onSearch={openSearchPage}
        />
      )}
      {!isMobile && (
      <aside className="sidebar">
        <h1>Loamium</h1>
        {navContent}
      </aside>
      )}
      {!isMobile && (
      <Resizer
        side="left"
        width={sidebarWidth}
        min={SIDEBAR_W.min}
        max={SIDEBAR_W.max}
        reset={SIDEBAR_W.default}
        onChange={setSidebarWidth}
        onCommit={(w) => { window.localStorage.setItem(SIDEBAR_W_KEY, String(w)) }}
        label="サイドバーの幅"
      />
      )}
      <main className="main">
        {view !== undefined ? (
          view.view?.render()
        ) : current === null ? (
          <div className="empty-state">
            <p className="empty-lead">ノートを開く</p>
            {isMobile ? (
              <ul className="empty-hints">
                <li>左上のメニューからノートを選ぶ</li>
                <li>上の虫めがねで探す</li>
              </ul>
            ) : (
              <ul className="empty-hints">
                <li><kbd>Ctrl</kbd><kbd>K</kbd> で探す</li>
                <li><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>D</kbd> で今日のジャーナルへ</li>
                <li>左のツリーから選ぶ</li>
              </ul>
            )}
          </div>
        ) : content === null ? (
          <p className="empty">読み込んでいます</p>
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
            actions={features.map((f) => (
              f.noteAction === undefined ? null : <Fragment key={f.name}>{f.noteAction({ path: current })}</Fragment>
            ))}
            beforePreset={editorPlugins(features, 'before-preset')}
            afterPreset={editorPlugins(features, 'after-preset')}
          />
        )}
      </main>
      {panelOpen && !isMobile && (
        <Resizer
          side="right"
          width={panelWidth}
          min={PANEL_W.min}
          max={PANEL_W.max}
          reset={PANEL_W.default}
          onChange={setPanelWidth}
          onCommit={(w) => { window.localStorage.setItem(PANEL_W_KEY, String(w)) }}
          label="情報パネルの幅"
        />
      )}
      {!isMobile && (
        <InfoPanel
          open={panelOpen}
          onToggle={() => { setPanelOpen((v) => !v) }}
          path={current}
          content={content}
          features={features}
        />
      )}
    </div>
    {/* モバイルの 2 面はドロワーで重ねる (縦に積まない) */}
    {isMobile && (
      <Drawer open={navOpen} onClose={() => { setNavOpen(false) }} side="left" title="ノート">
        {navContent}
      </Drawer>
    )}
    {isMobile && (
      <Drawer open={infoOpen} onClose={() => { setInfoOpen(false) }} side="right" title="情報">
        <InfoPanel open onToggle={() => { setInfoOpen(false) }} path={current} content={content} features={features} />
      </Drawer>
    )}
    {/* 重ねるものはグリッドの外に出す。中に置くと余分な行ができて本文の高さが縮む */}
    {features.map((feature) => (
      feature.overlay === undefined ? null : <Fragment key={feature.name}>{feature.overlay()}</Fragment>
    ))}
    </ShellProvider>
  )
}
