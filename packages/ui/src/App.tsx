/**
 * Loamium UI ルート (Sf1a90a で刷新)。
 *
 * シェル: 左サイドバー (直近ファイル) / 中央メイン 1 画面 / 右サイドバー
 * (バックリンク ⇄ Claude トグル)。タブは廃止し、ブラウザ的ルーティング
 * (History API — router.ts) に統一した。ノート=/n/{path}、アセット一覧=/files。
 *
 * - 起動時は URL に従って着地 (未指定は今日のジャーナル — DESIGN_PRINCIPLES ui_ux)。
 * - ノート/検索結果/[[リンク]]/バックリンク/embed の遷移はすべて履歴に積まれ、
 *   ブラウザおよびヘッダの戻る/進むで辿れる。開いているノートは URL に反映され、
 *   リロードで復帰する。
 * - 保存は Cmd/Ctrl+S + デバウンス自動保存。遷移前に flush、リロード/離脱は
 *   未保存があれば beforeunload で警告する。
 * - ファイルはピュア Markdown のまま (priority 1) — UI は content 文字列しか送らない。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react';
import {
  isValidJournalDate,
  journalPath,
  shiftJournalDate,
  todayJournalDate,
  type FileMeta,
  type NoteMeta,
} from '@loamium/shared';
import { api, ApiError } from './api.js';
import { formatSize } from './file-kind.js';
import {
  parseLocation,
  routeToPath,
  searchParamsToQuery,
  type Route,
  type SearchParams,
} from './router.js';
import { Editor } from './components/Editor.js';
import { FilePreview } from './components/FilePreview.js';
import { FilesPage } from './components/FilesPage.js';
import { FileTree } from './components/FileTree.js';
import { JournalNav } from './components/JournalNav.js';
import { RightSidebar } from './components/RightSidebar.js';
import { ContextMenu } from './components/ContextMenu.js';
import { ConflictDialog, DeleteDialog, NameDialog } from './components/dialogs.js';
import { SearchPalette } from './components/SearchPalette.js';
import { SearchPage } from './components/SearchPage.js';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckCircleIcon,
  CloseIcon,
  DocumentIcon,
  GearIcon,
  LinkIcon,
  NewNoteIcon,
  NewFolderIcon,
  SearchIcon,
  UploadIcon,
  WarnTriangleIcon,
} from './icons.js';

const AUTOSAVE_DEBOUNCE_MS = 1500;
const JOURNAL_FILE_RE = /^journals\/(\d{4}-\d{2}-\d{2})\.md$/;

type HistoryMode = 'push' | 'replace' | 'none';

interface OpenDoc {
  path: string;
  /** エディタへ渡す本文 (docPath / resetToken 変更時のみ反映される) */
  text: string;
  mtime: number | null;
  /** journals/YYYY-MM-DD.md のときの日付 */
  journalDate: string | null;
  resetToken: number;
}

type DialogState =
  | { type: 'new-note'; folder: string }
  | { type: 'new-folder'; parent: string }
  | { type: 'rename'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename-file'; path: string }
  | { type: 'delete-file'; path: string }
  | null;

interface MenuState {
  x: number;
  y: number;
  path: string;
  kind: 'note' | 'attachment' | 'folder';
}

/** アップロードのトースト (Sf53ad6-2 — prototype/upload.html)。 */
interface UploadToast {
  id: number;
  kind: 'progress' | 'renamed' | 'error';
  title: string;
  sub: string;
}

function journalDateOf(path: string): string | null {
  const m = JOURNAL_FILE_RE.exec(path);
  const date = m?.[1];
  return date !== undefined && isValidJournalDate(date) ? date : null;
}

function dirnameOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** history.state に載せた履歴インデックスを安全に読む (any を経由しない)。 */
function historyIndexOf(state: unknown): number {
  if (typeof state === 'object' && state !== null && 'index' in state) {
    const idx = (state as { index: unknown }).index;
    if (typeof idx === 'number') return idx;
  }
  return 0;
}

/**
 * リネームダイアログの「[[リンク]] N 件を自動更新」表示 (S6fbf45-3 /
 * prototype/tree-rename.html)。件数は GET /api/backlinks から求める。
 */
function RenameLinkNote({ path }: { path: string }): JSX.Element {
  const [counts, setCounts] = useState<{ notes: number; links: number } | 'loading' | 'error'>(
    'loading',
  );
  useEffect(() => {
    let cancelled = false;
    api.getBacklinks(path).then(
      (res) => {
        if (cancelled) return;
        setCounts({
          notes: res.backlinks.length,
          links: res.backlinks.reduce((n, s) => n + s.links.length, 0),
        });
      },
      () => {
        if (!cancelled) setCounts('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div className="link-update-note" data-testid="rename-link-note">
      <LinkIcon />
      <span>
        {counts === 'loading' ? (
          '参照元の [[リンク]] を確認しています…'
        ) : counts === 'error' ? (
          'リンク数を確認できませんでした (リネーム自体はリンク追従つきで実行されます)。'
        ) : counts.links === 0 ? (
          'このノートへの [[リンク]] はありません。リネームのみ実行します。'
        ) : (
          <>
            {counts.notes} ノートにある <strong>[[リンク]] {counts.links} 件</strong>
            を自動更新します (<code>[[名前#見出し]]</code> / <code>[[名前|表示名]]</code>{' '}
            形式を含む)。コードフェンス内は変更されません。
          </>
        )}
      </span>
    </div>
  );
}

export function App(): JSX.Element {
  // ---- サイドバー: ノート一覧と添付 ----
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [toasts, setToasts] = useState<UploadToast[]>([]);
  // フォルダツリーの折りたたみ状態 (S79c210-1)。既定は全展開 (集合が空)。
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  // UI 状態としてのみ存在する空フォルダ (フォルダ内フォルダの新規作成)。
  // vault にファイルは書かず、最初のノート作成で実体化する (priority 1)。
  const [extraFolders, setExtraFolders] = useState<string[]>([]);

  // ---- エディタ / 保存 ----
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);

  // ---- ルーティング (Sf1a90a-1) ----
  const [route, setRoute] = useState<Route>({ kind: 'home' });
  const routeRef = useRef<Route>(route);
  routeRef.current = route;
  const histIndexRef = useRef(0);
  const histMaxRef = useRef(0);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  // ---- ジャーナル ----
  const [today, setToday] = useState<string | null>(null);
  const [journalListOpen, setJournalListOpen] = useState(false);

  // ---- ポップアップ ----
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 全文ヒット確定時のカーソル移動指示 (Editor の seek prop へ) */
  const [seek, setSeek] = useState<{ line: number; token: number } | null>(null);
  const seekCounterRef = useRef(0);
  /** 保存成功のたびに増える — 右サイドバーのバックリンク再取得トリガー (S6fbf45-2) */
  const [backlinksToken, setBacklinksToken] = useState(0);

  const docRef = useRef<OpenDoc | null>(null);
  const previewRef = useRef<string | null>(null);
  const contentRef = useRef('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetCounterRef = useRef(0);
  docRef.current = doc;
  previewRef.current = preview;

  const refreshNotes = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listNotes();
      setNotes(res.notes);
      setNotesError(null);
    } catch (err) {
      setNotesError(errMessage(err));
    }
  }, []);

  const filesRef = useRef<FileMeta[] | null>(null);
  filesRef.current = files;
  const refreshFiles = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listFiles();
      setFiles(res.files);
    } catch (err) {
      // 添付一覧が取れなくてもノート編集は妨げない
      console.error('[loamium] failed to load attachment list:', err);
    }
  }, []);

  // ---- トースト (Sf53ad6-2) ----
  const toastCounterRef = useRef(0);
  const removeToast = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const pushToast = useCallback(
    (toast: Omit<UploadToast, 'id'>): number => {
      toastCounterRef.current += 1;
      const id = toastCounterRef.current;
      setToasts((prev) => [...prev, { ...toast, id }]);
      if (toast.kind !== 'progress') {
        const ttl = toast.kind === 'error' ? 10_000 : 6_000;
        setTimeout(() => removeToast(id), ttl);
      }
      return id;
    },
    [removeToast],
  );

  const markSaved = useCallback((path: string, mtime: number): void => {
    setDoc((d) => (d !== null && d.path === path ? { ...d, mtime } : d));
  }, []);

  /**
   * 現在の編集内容を保存する。
   * @returns true = 保存済み or 保存不要 / false = 競合・エラーで未保存
   */
  const saveNow = useCallback(
    async (opts?: { force?: boolean }): Promise<boolean> => {
      const d = docRef.current;
      if (d === null) return true;
      if (!dirtyRef.current) return true;
      if (savingRef.current) return false;
      savingRef.current = true;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const text = contentRef.current;
      try {
        const base = opts?.force === true || d.mtime === null ? undefined : d.mtime;
        const res = await api.putNote(d.path, text, base);
        markSaved(d.path, res.mtime);
        if (docRef.current !== null) docRef.current = { ...docRef.current, mtime: res.mtime };
        if (contentRef.current === text) {
          dirtyRef.current = false;
          setDirty(false);
        }
        setConflictPath(null);
        setAppError(null);
        if (res.created) void refreshNotes();
        setBacklinksToken((v) => v + 1);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setConflictPath(d.path);
        } else {
          setAppError(`保存に失敗しました — ${errMessage(err)}`);
        }
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [markSaved, refreshNotes],
  );

  const onEditorChange = useCallback(
    (text: string): void => {
      contentRef.current = text;
      dirtyRef.current = true;
      setDirty(true);
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void saveNow();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [saveNow],
  );

  const setOpenDoc = useCallback((path: string, text: string, mtime: number | null): void => {
    resetCounterRef.current += 1;
    const next: OpenDoc = {
      path,
      text,
      mtime,
      journalDate: journalDateOf(path),
      resetToken: resetCounterRef.current,
    };
    contentRef.current = text;
    dirtyRef.current = false;
    docRef.current = next;
    setDoc(next);
    setDirty(false);
    setSeek(null);
  }, []);

  // ---- 履歴同期 ----
  const syncNavFlags = useCallback((): void => {
    setCanBack(histIndexRef.current > 0);
    setCanForward(histIndexRef.current < histMaxRef.current);
  }, []);

  /** Route を URL/履歴へ反映する (push=新規履歴 / replace=現在を差替 / none=履歴不変)。 */
  const applyHistory = useCallback(
    (r: Route, mode: HistoryMode): void => {
      if (mode === 'push') {
        histIndexRef.current += 1;
        histMaxRef.current = histIndexRef.current;
        window.history.pushState({ index: histIndexRef.current }, '', routeToPath(r));
      } else if (mode === 'replace') {
        window.history.replaceState({ index: histIndexRef.current }, '', routeToPath(r));
      }
      routeRef.current = r;
      setRoute(r);
      syncNavFlags();
    },
    [syncNavFlags],
  );

  // ---- ノート/ジャーナルの読み込み (履歴は呼び出し側で反映) ----
  const loadNote = useCallback(
    async (path: string): Promise<string | null> => {
      if (docRef.current?.path === path && previewRef.current === null) return path;
      if (!(await saveNow())) return null;
      try {
        const res = await api.getNote(path);
        setPreview(null);
        setOpenDoc(res.path, res.content, res.mtime);
        setAppError(null);
        return res.path;
      } catch (err) {
        setAppError(`ノートを開けませんでした — ${errMessage(err)}`);
        return null;
      }
    },
    [saveNow, setOpenDoc],
  );

  const loadJournal = useCallback(
    async (date?: string): Promise<{ path: string; date: string } | null> => {
      if (!(await saveNow())) return null;
      try {
        const res = await api.getJournal(date);
        setPreview(null);
        setOpenDoc(res.path, res.content, res.mtime);
        if (date === undefined) setToday(res.date);
        if (res.created) void refreshNotes();
        setAppError(null);
        return { path: res.path, date: res.date };
      } catch (err) {
        setAppError(`ジャーナルを開けませんでした — ${errMessage(err)}`);
        return null;
      }
    },
    [refreshNotes, saveNow, setOpenDoc],
  );

  /** ノートルートへ遷移する (ジャーナルは getJournal で materialize)。 */
  const applyNote = useCallback(
    async (path: string, mode: HistoryMode): Promise<boolean> => {
      const jd = journalDateOf(path);
      const loadedPath = jd !== null ? ((await loadJournal(jd))?.path ?? null) : await loadNote(path);
      if (loadedPath === null) return false;
      applyHistory({ kind: 'note', path: loadedPath }, mode);
      return true;
    },
    [applyHistory, loadJournal, loadNote],
  );

  /** [[リンク]]/バックリンク/検索/embed/ツリーからノートを開く (履歴に積む)。 */
  const openNotePath = useCallback(
    async (path: string): Promise<void> => {
      await applyNote(path, 'push');
    },
    [applyNote],
  );

  /** 全文検索ヒットの確定: ノートを開き、該当行へカーソルを移動する。 */
  const openNoteAtLine = useCallback(
    async (path: string, line: number): Promise<void> => {
      if (!(await applyNote(path, 'push'))) return;
      seekCounterRef.current += 1;
      setSeek({ line, token: seekCounterRef.current });
    },
    [applyNote],
  );

  /** ジャーナル日付ナビ (前日/翌日/今日/一覧選択)。履歴に積む。 */
  const openJournalNav = useCallback(
    async (date?: string): Promise<void> => {
      const res = await loadJournal(date);
      if (res === null) return;
      applyHistory({ kind: 'note', path: res.path }, 'push');
    },
    [applyHistory, loadJournal],
  );

  /** アセット/ファイル一覧ページ (/files) へ遷移 (Sf1a90a-3「すべて表示」)。 */
  const showFiles = useCallback((): void => {
    void saveNow();
    // エディタ再マウント時に最新の編集内容から復元できるよう text を同期する
    setDoc((d) => (d !== null ? { ...d, text: contentRef.current } : d));
    setPreview(null);
    applyHistory({ kind: 'files' }, 'push');
  }, [applyHistory, saveNow]);

  /**
   * 詳細検索ページ (/search?…) へ遷移 (S935867-1)。条件は URL クエリに同期する。
   * Cmd+K パレットの「詳細検索を開く」導線・検索フォーム送信・履歴クリックから呼ばれる。
   */
  const openSearch = useCallback(
    (params: SearchParams): void => {
      void saveNow();
      setDoc((d) => (d !== null ? { ...d, text: contentRef.current } : d));
      setPreview(null);
      applyHistory({ kind: 'search', params }, 'push');
    },
    [applyHistory, saveNow],
  );

  /**
   * 添付ファイルのプレビューを開く (Sf53ad6-2: ツリーの tree-file クリック)。
   * 開いているノートは保存してから切り替える (エディタは一時アンマウントされる)。
   */
  const openFilePreview = useCallback(
    async (path: string): Promise<void> => {
      if (!(await saveNow())) return;
      setDoc((d) => (d !== null ? { ...d, text: contentRef.current } : d));
      // /files ページ表示中に添付を選んだらノート領域 (プレビュー) へ戻す
      if (routeRef.current.kind !== 'note' && docRef.current !== null) {
        applyHistory({ kind: 'note', path: docRef.current.path }, 'push');
      }
      setPreview(path);
      setAppError(null);
    },
    [applyHistory, saveNow],
  );

  /**
   * [[リンク]] からのノート作成 (S6fbf45-1)。
   * baseMtime: 0 の create-only PUT なので既存ノートを上書きしない (priority 2)。
   */
  const createNoteFromLink = useCallback(
    async (target: string, open: boolean): Promise<void> => {
      const t = target.trim().normalize('NFC');
      if (t.length === 0) return;
      if (/\.[A-Za-z0-9]+$/.test(t) && !/\.md$/i.test(t)) {
        setAppError(`ノート以外のファイルは [[リンク]] から作成できません — ${t}`);
        return;
      }
      const rel = /\.md$/i.test(t) ? t : `${t}.md`;
      try {
        await api.putNote(rel, '', 0);
        setAppError(null);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) {
          setAppError(`ノートを作成できませんでした — ${errMessage(err)}`);
          return;
        }
      }
      void refreshNotes();
      if (open) await openNotePath(rel);
    },
    [openNotePath, refreshNotes],
  );

  // ---- 起動: URL に従って着地 (Sf1a90a-1) ----
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    void refreshNotes();
    void refreshFiles();
    // ジャーナル日付ナビ用の today (server 応答があれば上書きされる)
    setToday(todayJournalDate());
    // 現在のエントリに履歴インデックスを刻む
    window.history.replaceState({ index: 0 }, '', window.location.pathname + window.location.search);
    const r0 = parseLocation(window.location.pathname, window.location.search);
    if (r0.kind === 'note') {
      void applyNote(r0.path, 'replace').then((ok) => {
        if (ok) return;
        // 対象ノートが無い等 → 今日のジャーナルへフォールバック
        void loadJournal().then((res) => {
          if (res !== null) applyHistory({ kind: 'note', path: res.path }, 'replace');
        });
      });
    } else if (r0.kind === 'files') {
      applyHistory({ kind: 'files' }, 'replace');
    } else if (r0.kind === 'search') {
      applyHistory({ kind: 'search', params: r0.params }, 'replace');
    } else {
      void loadJournal().then((res) => {
        if (res !== null) applyHistory({ kind: 'note', path: res.path }, 'replace');
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- ブラウザの戻る/進む (popstate) ----
  useEffect(() => {
    const onPop = (e: PopStateEvent): void => {
      histIndexRef.current = historyIndexOf(e.state);
      syncNavFlags();
      const r = parseLocation(window.location.pathname, window.location.search);
      if (r.kind === 'files') {
        setPreview(null);
        applyHistory(r, 'none');
      } else if (r.kind === 'search') {
        setPreview(null);
        applyHistory(r, 'none');
      } else if (r.kind === 'note') {
        void applyNote(r.path, 'none');
      } else {
        void loadJournal().then((res) => {
          if (res !== null) applyHistory({ kind: 'note', path: res.path }, 'none');
        });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyHistory, applyNote, loadJournal, syncNavFlags]);

  // ---- 未保存変更の離脱ガード (リロード/タブ閉じ) ----
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ---- グローバルキー: Cmd/Ctrl+S (保存) / Cmd/Ctrl+K (検索) / F2 (リネーム) ----
  const modalOpenRef = useRef(false);
  modalOpenRef.current = dialog !== null || conflictPath !== null || menu !== null;
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteOpen;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!modalOpenRef.current) {
          e.preventDefault();
          setPaletteOpen(true);
        }
      } else if (
        e.key === 'F2' &&
        docRef.current !== null &&
        !modalOpenRef.current &&
        !paletteOpenRef.current
      ) {
        e.preventDefault();
        setDialog({ type: 'rename', path: docRef.current.path });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNow]);

  // ---- フォルダツリー (S79c210-1) ----
  const activeSidebarPath = preview ?? doc?.path ?? null;

  const toggleFolder = useCallback((path: string): void => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** path の全祖先フォルダを展開する (新規作成したフォルダ/ノートを見失わない)。 */
  const expandAncestors = useCallback((folder: string): void => {
    if (folder === '') return;
    const parts = folder.split('/');
    const ancestors: string[] = [];
    for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join('/'));
    setCollapsedFolders((prev) => {
      if (ancestors.every((a) => !prev.has(a))) return prev;
      const next = new Set(prev);
      for (const a of ancestors) next.delete(a);
      return next;
    });
  }, []);

  const onContextMenuNote = useCallback((e: MouseEvent, path: string): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path, kind: 'note' });
  }, []);

  const onContextMenuFolder = useCallback((e: MouseEvent, path: string): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path, kind: 'folder' });
  }, []);

  const notePaths = useMemo(() => new Set((notes ?? []).map((n) => n.path)), [notes]);

  /** ツリー上に存在するフォルダパス集合 (ノート由来 + UI 合成の空フォルダ)。 */
  const folderPaths = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes ?? []) {
      const parts = n.path.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    for (const f of extraFolders) if (f !== '') set.add(f);
    return set;
  }, [notes, extraFolders]);

  const validateFolderName = useCallback(
    (parent: string) =>
      (name: string): string | null => {
        const trimmed = name.trim();
        if (trimmed === '') return 'フォルダ名を入力してください';
        if (trimmed.includes('/')) return 'フォルダ名に / は使えません';
        if (trimmed === '.' || trimmed === '..') return '使用できないフォルダ名です';
        const path = (parent === '' ? trimmed : `${parent}/${trimmed}`).normalize('NFC');
        if (folderPaths.has(path)) return '同名のフォルダが既にあります';
        return null;
      },
    [folderPaths],
  );

  /**
   * フォルダ内フォルダの新規作成 (S79c210-1)。空フォルダは vault にファイルを書かず
   * UI 状態 extraFolders として保持し、最初のノート作成で実体化する (priority 1)。
   */
  const createFolder = useCallback(
    (parent: string, name: string): void => {
      const trimmed = name.trim().normalize('NFC');
      const path = parent === '' ? trimmed : `${parent}/${trimmed}`;
      setDialog(null);
      setExtraFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
      // 親フォルダを展開して、作成したフォルダが見えるようにする
      expandAncestors(parent);
    },
    [expandAncestors],
  );

  const validateNoteName = useCallback(
    (folder: string) =>
      (name: string): string | null => {
        if (name === '') return 'ノート名を入力してください';
        if (name.includes('/')) return 'ノート名に / は使えません';
        const path = folder === '' ? `${name}.md` : `${folder}/${name}.md`;
        if (notePaths.has(path.normalize('NFC'))) return '同名のノートが既にあります';
        return null;
      },
    [notePaths],
  );

  const createNote = useCallback(
    async (folder: string, name: string): Promise<void> => {
      const path = folder === '' ? `${name}.md` : `${folder}/${name}.md`;
      setDialog(null);
      try {
        const res = await api.putNote(path, '', 0);
        await refreshNotes();
        // 作成先フォルダ (と祖先) を展開してツリー上で見えるようにする
        expandAncestors(dirnameOf(res.path));
        setOpenDoc(res.path, '', res.mtime);
        applyHistory({ kind: 'note', path: res.path }, 'push');
        setAppError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setAppError(`同名のノートが既に存在します — ${path}`);
          void refreshNotes();
        } else {
          setAppError(`ノートを作成できませんでした — ${errMessage(err)}`);
        }
      }
    },
    [applyHistory, expandAncestors, refreshNotes, setOpenDoc],
  );

  const renameNote = useCallback(
    async (oldPath: string, newName: string): Promise<void> => {
      const folder = dirnameOf(oldPath);
      const newPath = folder === '' ? `${newName}.md` : `${folder}/${newName}.md`;
      setDialog(null);
      if (newPath === oldPath) return;
      try {
        if (!(await saveNow())) return;
        const res = await api.renameNote(oldPath, newPath);
        await refreshNotes();
        const openPath = docRef.current?.path;
        if (openPath === oldPath) {
          const note = await api.getNote(res.path);
          setOpenDoc(note.path, note.content, note.mtime);
          // 開いているノート自身のリネーム → URL を新パスへ差替 (履歴は増やさない)
          applyHistory({ kind: 'note', path: note.path }, 'replace');
        } else if (openPath !== undefined && res.updatedNotes.some((u) => u.path === openPath)) {
          const note = await api.getNote(openPath);
          setOpenDoc(note.path, note.content, note.mtime);
        }
        setBacklinksToken((v) => v + 1);
        setAppError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setAppError(`リネーム先に同名のノートが既に存在します — ${newPath}`);
        } else {
          setAppError(`リネームできませんでした — ${errMessage(err)}`);
        }
        void refreshNotes();
      }
    },
    [applyHistory, refreshNotes, saveNow, setOpenDoc],
  );

  const deleteNote = useCallback(
    async (path: string): Promise<void> => {
      setDialog(null);
      try {
        await api.deleteNote(path);
        await refreshNotes();
        if (docRef.current?.path === path) {
          docRef.current = null;
          contentRef.current = '';
          dirtyRef.current = false;
          setDoc(null);
          setDirty(false);
        }
        setAppError(null);
      } catch (err) {
        setAppError(`削除できませんでした — ${errMessage(err)}`);
      }
    },
    [refreshNotes],
  );

  // ---- 添付ファイル: アップロード / リネーム / 削除 (Sf53ad6-2) ----
  const sanitizeUploadName = useCallback((raw: string, mime: string): string => {
    let name = (raw.split(/[\\/]/).pop() ?? '').trim().normalize('NFC').replace(/^\.+/, '');
    if (name === '') {
      const sub = (mime.split('/')[1] ?? '').replace(/[^a-z0-9]/gi, '');
      name = mime.startsWith('image/')
        ? `image.${sub === '' ? 'png' : sub}`
        : `file.${sub === '' ? 'bin' : sub}`;
    }
    return name;
  }, []);

  const uploadOne = useCallback(
    async (file: File): Promise<string | null> => {
      const name = sanitizeUploadName(file.name, file.type);
      const progressId = pushToast({
        kind: 'progress',
        title: `アップロード中 — ${name}`,
        sub: `assets/${name} · ${formatSize(file.size)}`,
      });
      try {
        const known = new Set((filesRef.current ?? []).map((f) => f.path));
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        for (let n = 0; n <= 99; n++) {
          const candidate = n === 0 ? `assets/${name}` : `assets/${stem}-${String(n)}${ext}`;
          if (known.has(candidate)) continue;
          try {
            const res = await api.uploadFile(candidate, file);
            removeToast(progressId);
            if (res.path !== `assets/${name}`) {
              pushToast({
                kind: 'renamed',
                title: 'アップロード完了(リネーム)',
                sub: `${name} は既に存在するため ${res.path.split('/').at(-1) ?? res.path} として保存しました`,
              });
            }
            void refreshFiles();
            return res.path;
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) continue;
            throw err;
          }
        }
        throw new Error('空きファイル名が見つかりません (連番 -99 まで使用済み)');
      } catch (err) {
        removeToast(progressId);
        pushToast({
          kind: 'error',
          title: 'アップロードに失敗しました',
          sub: `${name} — ${errMessage(err)}`,
        });
        return null;
      }
    },
    [pushToast, refreshFiles, removeToast, sanitizeUploadName],
  );

  const uploadFiles = useCallback(
    async (uploads: File[]): Promise<string[]> => {
      const out: string[] = [];
      for (const f of uploads) {
        const p = await uploadOne(f);
        if (p !== null) out.push(p);
      }
      return out;
    },
    [uploadOne],
  );

  const filePathSet = useMemo(() => new Set((files ?? []).map((f) => f.path)), [files]);

  const renameAttachment = useCallback(
    async (oldPath: string, newName: string): Promise<void> => {
      const folder = dirnameOf(oldPath);
      const newPath = folder === '' ? newName : `${folder}/${newName}`;
      setDialog(null);
      if (newPath === oldPath) return;
      try {
        const res = await api.renameFile(oldPath, newPath);
        await refreshFiles();
        if (preview === oldPath) setPreview(res.path);
        const openPath = docRef.current?.path;
        if (openPath !== undefined && res.updatedNotes.some((u) => u.path === openPath)) {
          const note = await api.getNote(openPath);
          setOpenDoc(note.path, note.content, note.mtime);
        }
        setBacklinksToken((v) => v + 1);
        setAppError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setAppError(`リネーム先に同名のファイルが既に存在します — ${newPath}`);
        } else {
          setAppError(`リネームできませんでした — ${errMessage(err)}`);
        }
        void refreshFiles();
      }
    },
    [preview, refreshFiles, setOpenDoc],
  );

  const deleteAttachment = useCallback(
    async (path: string): Promise<void> => {
      setDialog(null);
      try {
        await api.deleteFile(path);
        await refreshFiles();
        if (preview === path) setPreview(null);
        setAppError(null);
      } catch (err) {
        setAppError(`削除できませんでした — ${errMessage(err)}`);
      }
    },
    [preview, refreshFiles],
  );

  // ---- ジャーナルナビゲーション ----
  const journalEntries = useMemo(
    () =>
      (notes ?? [])
        .map((n) => JOURNAL_FILE_RE.exec(n.path)?.[1])
        .filter((d): d is string => d !== undefined && isValidJournalDate(d))
        .sort((a, b) => (a < b ? 1 : -1))
        .map((date) => ({ date })),
    [notes],
  );

  const journalBaseDate = doc?.journalDate ?? today;

  // ---- 競合ダイアログ ----
  const resolveConflictOverwrite = useCallback((): void => {
    setConflictPath(null);
    void saveNow({ force: true });
  }, [saveNow]);

  const resolveConflictReload = useCallback(async (): Promise<void> => {
    const d = docRef.current;
    setConflictPath(null);
    if (d === null) return;
    try {
      const res = await api.getNote(d.path);
      setOpenDoc(res.path, res.content, res.mtime);
      setAppError(null);
    } catch (err) {
      setAppError(`再読み込みに失敗しました — ${errMessage(err)}`);
    }
  }, [setOpenDoc]);

  // ---- 現在ルート表示 (route-display) 用のパンくず ----
  const breadcrumb = useMemo(() => {
    const target = preview ?? doc?.path ?? null;
    if (target === null) return null;
    const segs = target.split('/');
    const file = segs.at(-1) ?? target;
    const name = preview === null && file.endsWith('.md') ? file.slice(0, -3) : file;
    return { folders: segs.slice(0, -1), name };
  }, [doc, preview]);

  return (
    <div className="app">
      {/* ================= 左: サイドバー (直近ファイル) ================= */}
      <aside className="sidebar" data-testid="sidebar">
        <div className="sidebar-header">
          <div className="vault-badge">L</div>
          <div className="vault-name">Loamium</div>
          <button
            className="icon-btn"
            data-testid="sidebar-search"
            title="検索 (Ctrl+K)"
            onClick={() => setPaletteOpen(true)}
          >
            <SearchIcon />
          </button>
          <button className="icon-btn" data-testid="sidebar-settings" title="設定 (未実装)" disabled>
            <GearIcon />
          </button>
        </div>

        <JournalNav
          today={today}
          baseDate={journalBaseDate}
          entries={journalEntries}
          listOpen={journalListOpen}
          onPrev={() => {
            if (journalBaseDate !== null) void openJournalNav(shiftJournalDate(journalBaseDate, -1));
          }}
          onNext={() => {
            if (journalBaseDate !== null) void openJournalNav(shiftJournalDate(journalBaseDate, 1));
          }}
          onToday={() => {
            setJournalListOpen(false);
            void openJournalNav();
          }}
          onToggleList={() => setJournalListOpen((v) => !v)}
          onSelectDate={(date) => {
            setJournalListOpen(false);
            void openJournalNav(date);
          }}
        />

        <div className="tree-section-title">
          <span>ノート</span>
          <span className="actions">
            <button
              className="icon-btn"
              data-testid="sidebar-new-note"
              title="新規ノート"
              onClick={() => setDialog({ type: 'new-note', folder: '' })}
            >
              <NewNoteIcon />
            </button>
            <button
              className="icon-btn"
              data-testid="sidebar-new-folder"
              title="新規フォルダ"
              onClick={() => setDialog({ type: 'new-folder', parent: '' })}
            >
              <NewFolderIcon />
            </button>
          </span>
        </div>

        <FileTree
          notes={notes}
          extraFolders={extraFolders}
          activePath={activeSidebarPath}
          collapsed={collapsedFolders}
          error={notesError}
          onToggleFolder={toggleFolder}
          onOpenNote={(path) => void openNotePath(path)}
          onContextMenuNote={onContextMenuNote}
          onContextMenuFolder={onContextMenuFolder}
        />

        <div className="tree-section-title show-all-row">
          <span className="recent-hint">画像・PDF 等の添付はこちら</span>
          <button
            className="show-all"
            data-testid="sidebar-show-all"
            onClick={showFiles}
          >
            すべてのファイルを表示 →
          </button>
        </div>
      </aside>

      {/* ================= 中央: メイン 1 画面 ================= */}
      <main className="workspace">
        <div className="editor-header">
          <div className="nav-group">
            <button
              className="nav-btn"
              data-testid="nav-back"
              title="戻る (履歴を1つ戻る)"
              disabled={!canBack}
              onClick={() => window.history.back()}
            >
              <ChevronLeftIcon />
            </button>
            <button
              className="nav-btn"
              data-testid="nav-forward"
              title="進む (履歴を1つ進む)"
              disabled={!canForward}
              onClick={() => window.history.forward()}
            >
              <ChevronRightIcon />
            </button>
          </div>
          <nav className="route-crumbs breadcrumb" data-testid="route-display" aria-label="現在のルート">
            {route.kind === 'files' ? (
              <span className="route-token">/files</span>
            ) : route.kind === 'search' ? (
              <>
                <span className="route-token">/search</span>
                {searchParamsToQuery(route.params) !== '' && (
                  <>
                    <span className="sep">?</span>
                    <span className="current">{searchParamsToQuery(route.params)}</span>
                  </>
                )}
              </>
            ) : breadcrumb !== null ? (
              // 内部ルート接頭辞 /n/ は露出しない (S79c210-4)。ノートアイコン +
              // フォルダ階層 + ノート名で構成する (URL 自体は /n/{path} のまま維持)。
              <>
                <span className="route-crumb-icon" aria-hidden="true">
                  <DocumentIcon />
                </span>
                {breadcrumb.folders.map((f, i) => (
                  <span key={`${f}-${String(i)}`}>
                    <span>{f}</span>
                    <span className="sep">/</span>
                  </span>
                ))}
                <span className="current">{breadcrumb.name}</span>
              </>
            ) : (
              <span className="current faint">ノートが開かれていません</span>
            )}
          </nav>
          {appError !== null && (
            <div className="app-error" data-testid="app-error" title={appError}>
              {appError}
            </div>
          )}
          {route.kind === 'note' && doc !== null && preview === null && (
            <div className="save-status" data-testid="save-status" data-state={dirty ? 'dirty' : 'saved'}>
              <span className="dot" />
              <span>{dirty ? '未保存' : '保存済み'}</span>
            </div>
          )}
        </div>

        {route.kind === 'search' ? (
          <SearchPage
            params={route.params}
            onNavigate={openSearch}
            onOpenNoteInEditor={(path) => void openNotePath(path)}
          />
        ) : route.kind === 'files' ? (
          <FilesPage
            notes={notes}
            files={files}
            onOpenNote={(path) => void openNotePath(path)}
            onRequestDelete={(path, kind) =>
              setDialog({ type: kind === 'note' ? 'delete' : 'delete-file', path })
            }
            onRequestRename={(path, kind) =>
              setDialog({ type: kind === 'note' ? 'rename' : 'rename-file', path })
            }
          />
        ) : preview !== null ? (
          <FilePreview path={preview} files={files} />
        ) : doc !== null ? (
          <Editor
            docPath={doc.path}
            content={doc.text}
            resetToken={doc.resetToken}
            seek={seek}
            notes={notes}
            files={files}
            onChange={onEditorChange}
            onSave={() => void saveNow()}
            onOpenNote={(path) => void openNotePath(path)}
            onOpenNoteAtLine={(path, line) => void openNoteAtLine(path, line)}
            onCreateAndOpenNote={(target) => void createNoteFromLink(target, true)}
            onCreateNote={(target) => void createNoteFromLink(target, false)}
            onUploadFiles={uploadFiles}
            onDragActive={setDragActive}
          />
        ) : (
          <div className="empty-state" data-testid="editor-empty-state">
            <div className="glyph">
              <DocumentIcon />
            </div>
            <h2>ようこそ Loamium へ</h2>
            <p>
              ノートが開かれていません。今日のジャーナルを開いて書き始めるのがおすすめです。
              ファイルはすべてピュアな Markdown として vault に保存されます。
            </p>
            <div className="empty-actions">
              <button
                className="btn primary"
                data-testid="empty-open-journal"
                onClick={() => void openJournalNav()}
              >
                今日のジャーナルを開始
              </button>
              <button
                className="btn"
                data-testid="empty-new-note"
                onClick={() => setDialog({ type: 'new-note', folder: '' })}
              >
                新規ノートを作成
              </button>
            </div>
            <div className="empty-hint">
              <span>
                <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存 (自動保存あり)
              </span>
              <span>
                <code>[[</code> でノートにリンク
              </span>
              <span>
                リスト行で <kbd>Tab</kbd> インデント
              </span>
            </div>
          </div>
        )}

        {/* D&D 中のドロップオーバーレイ (Sf53ad6-2 — prototype/upload.html) */}
        {dragActive && route.kind === 'note' && preview === null && doc !== null && (
          <div className="drop-overlay" data-testid="drop-overlay">
            <div className="drop-overlay-inner">
              <div className="glyph">
                <UploadIcon />
              </div>
              <h3>ドロップしてアップロード</h3>
              <p>
                <code>assets/</code> に保存し、カーソル位置に <code>![[パス]]</code> を挿入します
              </p>
            </div>
          </div>
        )}
      </main>

      {/* ================= 右: サイドバー (バックリンク | Claude) ================= */}
      {/* /search では非表示 (AC-Sa629e2-3-3)。unmount しない — xterm セッション維持 */}
      <RightSidebar
        notePath={route.kind === 'note' ? (doc?.path ?? null) : null}
        refreshToken={backlinksToken}
        onOpenNote={(path) => void openNotePath(path)}
        hidden={route.kind === 'search'}
      />

      {/* ================= ポップアップ ================= */}
      {paletteOpen && (
        <SearchPalette
          onClose={() => setPaletteOpen(false)}
          onOpenNote={(path) => void openNotePath(path)}
          onOpenNoteAtLine={(path, line) => void openNoteAtLine(path, line)}
          onOpenAdvanced={(q) => {
            setPaletteOpen(false);
            openSearch({ q: q.trim().normalize('NFC'), tag: '', folder: '', sort: 'updated' });
          }}
        />
      )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.path}
          isFolder={menu.kind === 'folder'}
          onOpen={() => {
            setMenu(null);
            if (menu.kind === 'attachment') void openFilePreview(menu.path);
            else void openNotePath(menu.path);
          }}
          onNewNote={() => {
            setMenu(null);
            // フォルダ対象ならそのフォルダ内、ノート対象なら同じフォルダに作る
            const folder = menu.kind === 'folder' ? menu.path : dirnameOf(menu.path);
            setDialog({ type: 'new-note', folder });
          }}
          onNewFolder={() => {
            setMenu(null);
            setDialog({ type: 'new-folder', parent: menu.path });
          }}
          onRename={() => {
            setMenu(null);
            setDialog({
              type: menu.kind === 'attachment' ? 'rename-file' : 'rename',
              path: menu.path,
            });
          }}
          onDelete={() => {
            setMenu(null);
            setDialog({
              type: menu.kind === 'attachment' ? 'delete-file' : 'delete',
              path: menu.path,
            });
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {dialog?.type === 'new-note' && (
        <NameDialog
          title="新規ノート"
          sub={dialog.folder === '' ? 'vault ルートに作成' : `${dialog.folder}/ に作成`}
          initial=""
          placeholder="ノート名"
          confirmLabel="作成"
          testids={{ dialog: 'new-note-dialog', input: 'new-note-input', confirm: 'new-note-confirm', cancel: 'new-note-cancel' }}
          validate={validateNoteName(dialog.folder)}
          onConfirm={(name) => void createNote(dialog.folder, name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'new-folder' && (
        <NameDialog
          title="新規フォルダ"
          sub={dialog.parent === '' ? 'vault ルートに作成' : `${dialog.parent}/ に作成`}
          initial=""
          placeholder="フォルダ名"
          confirmLabel="作成"
          testids={{ dialog: 'new-folder-dialog', input: 'new-folder-input', confirm: 'new-folder-confirm', cancel: 'new-folder-cancel' }}
          extra={
            <div className="link-update-note">
              <span>
                空のフォルダはファイルに書き込まれません(ピュア Markdown
                を保つため)。中に最初のノートを作成すると vault
                に実体化します。
              </span>
            </div>
          }
          validate={validateFolderName(dialog.parent)}
          onConfirm={(name) => createFolder(dialog.parent, name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'rename' && (
        <NameDialog
          title="ノートをリネーム"
          sub={dialog.path}
          initial={(dialog.path.split('/').at(-1) ?? '').replace(/\.md$/, '')}
          confirmLabel="リネームしてリンクを更新"
          testids={{ dialog: 'rename-dialog', input: 'rename-input', confirm: 'rename-confirm', cancel: 'rename-cancel' }}
          extra={<RenameLinkNote path={dialog.path} />}
          validate={(name) => {
            const current = (dialog.path.split('/').at(-1) ?? '').replace(/\.md$/, '');
            if (name === current) return null;
            return validateNoteName(dirnameOf(dialog.path))(name);
          }}
          onConfirm={(name) => void renameNote(dialog.path, name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'rename-file' && (
        <NameDialog
          title="ファイルをリネーム"
          sub={dialog.path}
          initial={dialog.path.split('/').at(-1) ?? ''}
          confirmLabel="リネームしてリンクを更新"
          testids={{ dialog: 'rename-dialog', input: 'rename-input', confirm: 'rename-confirm', cancel: 'rename-cancel' }}
          extra={
            <div className="link-update-note" data-testid="rename-link-note">
              <LinkIcon />
              <span>
                このファイルを参照する <code>![[リンク]]</code> は vault
                全体で自動更新されます。コードフェンス内は変更されません。
              </span>
            </div>
          }
          validate={(name) => {
            const current = dialog.path.split('/').at(-1) ?? '';
            if (name === current) return null;
            if (name === '') return 'ファイル名を入力してください';
            if (name.includes('/')) return 'ファイル名に / は使えません';
            if (name.startsWith('.')) return 'ドット始まりのファイル名は使えません';
            if (name.toLowerCase().endsWith('.md')) return '.md はノートとして作成してください';
            const folder = dirnameOf(dialog.path);
            const newPath = folder === '' ? name : `${folder}/${name}`;
            if (filePathSet.has(newPath.normalize('NFC'))) return '同名のファイルが既にあります';
            return null;
          }}
          onConfirm={(name) => void renameAttachment(dialog.path, name)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'delete' && (
        <DeleteDialog
          path={dialog.path}
          onConfirm={() => void deleteNote(dialog.path)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'delete-file' && (
        <DeleteDialog
          path={dialog.path}
          kind="file"
          onConfirm={() => void deleteAttachment(dialog.path)}
          onCancel={() => setDialog(null)}
        />
      )}

      {conflictPath !== null && (
        <ConflictDialog
          path={conflictPath}
          onOverwrite={resolveConflictOverwrite}
          onReload={() => void resolveConflictReload()}
        />
      )}

      {/* ---- アップロードのトースト (Sf53ad6-2 — prototype/upload.html) ---- */}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast${t.kind === 'renamed' ? ' success' : t.kind === 'error' ? ' error' : ''}`}
              data-testid="upload-toast"
              data-kind={t.kind}
            >
              <span className="t-ico">
                {t.kind === 'error' ? (
                  <WarnTriangleIcon />
                ) : t.kind === 'renamed' ? (
                  <CheckCircleIcon />
                ) : (
                  <UploadIcon />
                )}
              </span>
              <div className="t-main">
                <div className="t-title">{t.title}</div>
                <div className="t-sub">{t.sub}</div>
                {t.kind === 'progress' && (
                  <div className="progress">
                    <i />
                  </div>
                )}
              </div>
              <button className="t-close" title="閉じる" onClick={() => removeToast(t.id)}>
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
