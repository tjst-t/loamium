/**
 * Loamium UI ルート (Sf1a90a で刷新)。
 *
 * シェル: 左サイドバー (直近ファイル) / 中央メイン 1 画面 / 右サイドバー
 * (バックリンク)。タブは廃止し、ブラウザ的ルーティング
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
  noteTitle,
  shiftJournalDate,
  todayJournalDate,
  type FileMeta,
  type NoteMeta,
  type PermissionMode,
  type PropertyKeyCount,
  type PropertyTypeDef,
  type SystemFileMeta,
  type TagCount,
  type TemplateSummary,
} from '@loamium/shared';
import { api, ApiError } from './api.js';
import { useVaultEvents } from './useVaultEvents.js';
import { formatSize } from './file-kind.js';
import {
  parseLocation,
  routeToPath,
  searchParamsToQuery,
  type Route,
  type SearchParams,
  type SettingsGroup,
} from './router.js';
import { collectFolderPaths } from './tree.js';
import { makeTagClickHandler } from './tag-click.js';
import { isCommandFile, isSystemSourceFile } from './commandEditorUtils.js';
import { moveNote, moveFolder } from './folder-move.js';
import { BookmarkStar } from './components/BookmarkStar.js';
import { CommandEditor } from './components/CommandEditor.js';
import { Editor, type EditorView } from './components/Editor.js';
import { convertListToBullet, convertListToOrdered } from './list-convert-cmd.js';
import { MobileAgentSheet } from './components/MobileAgentSheet.js';
import { FilePreview } from './components/FilePreview.js';
import { FilesPage } from './components/FilesPage.js';
import { FileTree } from './components/FileTree.js';
import { SmartView } from './components/SmartView.js';
import { SystemFolderSection } from './components/SystemFolderSection.js';
import { JournalNav } from './components/JournalNav.js';
import { RightSidebar } from './components/RightSidebar.js';
import { ContextMenu } from './components/ContextMenu.js';
import { ConflictDialog, DeleteDialog, DeleteFolderDialog, NameDialog } from './components/dialogs.js';
import { MoveDialog } from './components/MoveDialog.js';
import { NewNoteDialog } from './components/NewNoteDialog.js';
import { SearchPalette } from './components/SearchPalette.js';
import { SearchPage } from './components/SearchPage.js';
import { TemplatePicker } from './components/TemplatePicker.js';
import { TemplateModal } from './components/TemplateModal.js';
import { SettingsView } from './components/SettingsView.js';
import {
  AgentNavIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckCircleIcon,
  CloseIcon,
  CollapseAllIcon,
  DocumentIcon,
  ExpandAllIcon,
  FolderIcon,
  GearIcon,
  LinkIcon,
  MenuIcon,
  NewNoteIcon,
  NewFolderIcon,
  NoteNavIcon,
  PlusIcon,
  ReloadIcon,
  SearchIcon,
  UploadIcon,
  WarnTriangleIcon,
} from './icons.js';

// fold 状態の確認・展開に使う (Sb6f1d3-2 TOC クリック時の unfold)
import { foldedRanges, unfoldEffect } from '@codemirror/language';

const AUTOSAVE_DEBOUNCE_MS = 1500;
const JOURNAL_FILE_RE = /^journals\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.md$/;

type HistoryMode = 'push' | 'replace' | 'none';

interface OpenDoc {
  path: string;
  /** エディタへ渡す本文 (docPath / resetToken 変更時のみ反映される) */
  text: string;
  mtime: number | null;
  /** journals/YYYY/MM/YYYY-MM-DD.md のときの日付 */
  journalDate: string | null;
  resetToken: number;
  /** サーバーから取得した frontmatter (BookmarkStar の初期値に使う) */
  frontmatter: Record<string, unknown> | null;
  /**
   * system/ 設定ファイル (yaml / md) を GET/PUT /api/system-files/{path}/source 経由で
   * 読み書きするドキュメントか (Sa10026-9 #4)。notes API は .md を強制するため、
   * settings.yaml / smart-folders/*.yaml 等はこの経路で扱う。
   */
  isSystemSource: boolean;
}

type DialogState =
  | { type: 'new-note'; folder: string }
  | { type: 'new-folder'; parent: string }
  | { type: 'rename'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename-file'; path: string }
  | { type: 'delete-file'; path: string }
  | { type: 'delete-folder'; folderPath: string; noteCount: number }
  | { type: 'smart-newfile' }
  | { type: 'move'; path: string; isFolder: boolean }
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
 * ロゴ右のバージョン表示用に文字列を整える。
 * git describe の開発サフィックス `-<コミット数>-g<ハッシュ>` を `+<コミット数>`
 * に置き換え、「タグからの距離」を残す。
 *   例 v0.1.0-111-gd05f5d7 → v0.1.0+111 (タグ v0.1.0 から 111 コミット先)
 * リリースタグちょうど (v1.2.3) や prerelease (v1.2.3-rc1) は変化しない。
 * ハッシュ付きの完全な値は title 属性に残す。
 */
function displayVersion(raw: string): string {
  return raw.replace(/-(\d+)-g[0-9a-f]+$/, '+$1');
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
  // ---- サイドバー: ビューモード (physical | smart) — localStorage に永続化 ----
  const [sidebarView, setSidebarView] = useState<'physical' | 'smart'>(() => {
    const stored = localStorage.getItem('loamium.sidebarView');
    return stored === 'smart' ? 'smart' : 'physical';
  });
  const switchSidebarView = useCallback((mode: 'physical' | 'smart'): void => {
    setSidebarView(mode);
    localStorage.setItem('loamium.sidebarView', mode);
  }, []);

  // ---- スマートビュー: モード + 作成フォームトリガー ----
  const [smartViewMode, setSmartViewMode] = useState<PermissionMode | null>(null);
  const [smartAddTrigger, setSmartAddTrigger] = useState(0);
  // コマンド保存後にスマートビューのコマンド一覧を再取得するトークン
  const [commandSaveToken, setCommandSaveToken] = useState(0);
  // ---- スマートビュー: 新規ファイルメニュー (Sebf6b0-3) ----
  const [smartNewFileMenuOpen, setSmartNewFileMenuOpen] = useState(false);
  // 新規ファイルダイアログ用: パス入力値 + フォルダ候補
  const [smartNewFilePath, setSmartNewFilePath] = useState('');
  const [smartNewFileNotes, setSmartNewFileNotes] = useState<NoteMeta[] | null>(null);
  const [smartNewFilePathOpen, setSmartNewFilePathOpen] = useState(false);
  const smartNewFilePathBlurRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 新規ノートダイアログ (統一・Sa10026-8) ----
  /** settings.yaml の defaultFolder (初期ロード後に確定する)。 */
  const [defaultFolder, setDefaultFolder] = useState('');
  /** settings.yaml の theme ('light' | 'dark' | 'system')。 */
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  /** settings.yaml の showSystemFolder (既定 false = 非表示)。 */
  const [showSystemFolder, setShowSystemFolder] = useState(false);
  /** 新規ノートダイアログ用のフォルダ補完ソース (遅延ロード)。 */
  const [newNoteNotes, setNewNoteNotes] = useState<NoteMeta[] | null>(null);

  // ---- サイドバー: ノート一覧と添付 ----
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  // system/ 設定ファイル一覧 (Sa10026-9 #1/#4) — サイドバー system/ ツリーの描画元
  const [systemFiles, setSystemFiles] = useState<SystemFileMeta[] | null>(null);
  // 意味型スキーマ (.loamium/property-types.json → キー→型定義)。既定 {} (S87f4b7-2)
  const [propertyTypes, setPropertyTypes] = useState<Record<string, PropertyTypeDef>>({});
  // vault 横断のプロパティキー候補 (件数付き — Sd13ab1-2)。キーファースト追加の zone ①
  const [propertyKeys, setPropertyKeys] = useState<PropertyKeyCount[] | null>(null);
  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [toasts, setToasts] = useState<UploadToast[]>([]);
  // フォルダツリーの折りたたみ状態 (S79c210-1)。既定は全展開 (集合が空)。
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  // スマートビューの全展開/全折りたたみ指示 (token インクリメントで全行に伝播)。
  const [smartTreeSignal, setSmartTreeSignal] = useState<{ action: 'expand' | 'collapse'; token: number }>(
    { action: 'expand', token: 0 },
  );
  // UI 状態としてのみ存在する空フォルダ (フォルダ内フォルダの新規作成)。
  // vault にファイルは書かず、最初のノート作成で実体化する (priority 1)。
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  // 選択中フォルダ (S2e8a4c-4): 新規ノート/フォルダ作成ダイアログの prefill に使う。
  const [selectedFolder, setSelectedFolder] = useState('');

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
  // ヘッダのリロードボタン。token インクリメントで設定/検索ページを再マウント (再取得)。
  const [reloadToken, setReloadToken] = useState(0);
  const [reloading, setReloading] = useState(false);

  // ---- ジャーナル ----
  const [today, setToday] = useState<string | null>(null);

  // ---- 設定画面 (Sa10026-7 → Sa10026-9 #2: ルート化) ----
  /** GET /api/health から取得したサーバーモード (設定画面の read-only 制御に使う) */
  const [appMode, setAppMode] = useState<PermissionMode>('full');

  // ---- ポップアップ ----
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ---- モバイル (Sa6c3b0) ----
  /** モバイルサイドバーオーバーレイの開閉 (AC-Sa6c3b0-1-2) */
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  /** モバイル Agent シートの開閉 (AC-Sa6c3b0-6-2) */
  const [mobileAgentSheetOpen, setMobileAgentSheetOpen] = useState(false);
  /** PWA インストールプロンプトの表示 (AC-Sa6c3b0-4) */
  const [pwaPromptVisible, setPwaPromptVisible] = useState(false);
  const pwaInstallEventRef = useRef<Event | null>(null);
  // ---- テンプレート (S89a350-3) ----
  const [newNoteMenuOpen, setNewNoteMenuOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modalTemplate, setModalTemplate] = useState<TemplateSummary | null>(null);
  /** 全文ヒット確定時のカーソル移動指示 (Editor の seek prop へ) */
  const [seek, setSeek] = useState<{ line: number; token: number } | null>(null);
  const seekCounterRef = useRef(0);
  /** 保存成功のたびに増える — 右サイドバーのバックリンク再取得トリガー (S6fbf45-2) */
  const [backlinksToken, setBacklinksToken] = useState(0);
  /** SSE sf_invalidated で通知された SF ID 配列 — SmartView の差分再フェッチに使う (Sd5c9f4-4) */
  const [sseSfInvalidatedIds, setSseSfInvalidatedIds] = useState<string[]>([]);

  /** EditorView ref (Sb6f1d3-2): TOC クリック時の unfoldEffect dispatch に使う */
  const editorViewRef = useRef<EditorView | null>(null);
  const docRef = useRef<OpenDoc | null>(null);
  const previewRef = useRef<string | null>(null);
  const contentRef = useRef('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetCounterRef = useRef(0);
  docRef.current = doc;
  previewRef.current = preview;

  // ---- テーマ適用: html[data-theme] を theme 設定に追従させる ----
  useEffect(() => {
    const html = document.documentElement;
    if (theme === 'dark') {
      html.setAttribute('data-theme', 'dark');
      return undefined;
    }
    if (theme === 'light') {
      html.removeAttribute('data-theme');
      return undefined;
    }
    // 'system': prefers-color-scheme: dark に追従
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark: boolean): void => {
      if (dark) {
        html.setAttribute('data-theme', 'dark');
      } else {
        html.removeAttribute('data-theme');
      }
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const refreshNotes = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listNotes();
      setNotes(res.notes);
      setNotesError(null);
    } catch (err) {
      setNotesError(errMessage(err));
    }
  }, []);

  // 意味型スキーマの読込 (S87f4b7-2)。取得失敗はヒューリスティックのみで動くため無視。
  const refreshPropertyTypes = useCallback(async (): Promise<void> => {
    try {
      setPropertyTypes(await api.getPropertyTypes());
    } catch (err) {
      console.error('[loamium] failed to load property types:', err);
    }
  }, []);

  // タグ一覧 (件数付き) の読込 (S45fa45)。`#` 候補補完の共通ソース。取得失敗は補完なしで動く。
  const refreshTags = useCallback(async (): Promise<void> => {
    try {
      setTags((await api.getTags()).tags);
    } catch (err) {
      console.error('[loamium] failed to load tags:', err);
    }
  }, []);

  // vault 横断プロパティキー候補の読込 (Sd13ab1-2)。取得失敗はサジェストなしで動く。
  const refreshPropertyKeys = useCallback(async (): Promise<void> => {
    try {
      setPropertyKeys(await api.getPropertyKeys());
    } catch (err) {
      console.error('[loamium] failed to load property keys:', err);
    }
  }, []);

  // エージェント/スマートコマンドがファイルを書き込んだ後に呼ぶ (S...sidebar-refresh)。
  // SSE push 基盤が無いため、書き込みが起きうる箇所の後でノート/タグ/プロパティキーを再取得し、
  // 左サイドバー (ファイルツリー) をリロード無しで最新化する。
  const onNotesChanged = useCallback((): void => {
    void refreshNotes();
    void refreshTags();
    void refreshPropertyKeys();
  }, [refreshNotes, refreshTags, refreshPropertyKeys]);

  // SSE イベント処理 (Sd5c9f4-4) は pushToast / setOpenDoc の後に定義 (Story 6 で使うため)。
  // → setOpenDoc / pushToast の定義後、useVaultEvents 購読を含めてまとめて下に移動。

  // 新規プロパティの型を .loamium/property-types.json へ永続化する (Sd13ab1-2)。
  // 永続化後、型スキーマとキー候補を最新化する (別ファイルでも同じ型に解決される)。
  const onPersistPropertyType = useCallback(
    (key: string, def: PropertyTypeDef): void => {
      void (async (): Promise<void> => {
        try {
          setPropertyTypes(await api.putPropertyType(key, def));
        } catch (err) {
          console.error('[loamium] failed to persist property type:', err);
        }
        void refreshPropertyKeys();
      })();
    },
    [refreshPropertyKeys],
  );

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

  // system/ 配下の設定ファイル一覧 (Sa10026-9 #1/#4)。yaml + md をフォルダ構造付きで持つ。
  const refreshSystemFiles = useCallback(async (): Promise<void> => {
    const res = await api.listSystemFiles();
    setSystemFiles(res.files);
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
      // ADR-0024: commands/*.yaml は CommandEditor が自分で保存するため App の saveNow は触らない
      if (isCommandFile(d.path)) return true;
      if (savingRef.current) return false;
      savingRef.current = true;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const text = contentRef.current;
      try {
        const base = opts?.force === true || d.mtime === null ? undefined : d.mtime;
        // Sa10026-9 #4: system/ 設定ファイルは system-files source 経由で書く (notes API は .md 強制)
        const res = d.isSystemSource
          ? await api.putSystemFileSource(d.path, text, base)
          : await api.putNote(d.path, text, base);
        markSaved(d.path, res.mtime);
        if (docRef.current !== null) docRef.current = { ...docRef.current, mtime: res.mtime };
        if (contentRef.current === text) {
          dirtyRef.current = false;
          setDirty(false);
        }
        setConflictPath(null);
        setAppError(null);
        if (res.created) void (d.isSystemSource ? refreshSystemFiles() : refreshNotes());
        // system/ 設定ファイル保存後は system/ ツリーの mtime 等を最新化する (Sa10026-9 #4)
        if (d.isSystemSource) void refreshSystemFiles();
        // 保存でインデックスが更新される → タグ候補ソースを最新化する (S45fa45)
        void refreshTags();
        // frontmatter キーが増減しうる → キーファースト候補も最新化する (Sd13ab1-2)
        void refreshPropertyKeys();
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
    [markSaved, refreshNotes, refreshSystemFiles, refreshTags, refreshPropertyKeys],
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

  /**
   * CommandEditor 用の onChange: contentRef / dirtyRef を更新するが自動保存は起動しない。
   * CommandEditor は無効定義でも書き続けられる必要があるため、自動保存の代わりに
   * 手動の保存ボタン(cmd-edit-save)のみで PUT する。
   */
  const onCommandEditorChange = useCallback((text: string): void => {
    contentRef.current = text;
    dirtyRef.current = true;
    setDirty(true);
    // 既存の自動保存タイマーがあればキャンセル (通常エディタからの切り替え残留を防ぐ)
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const setOpenDoc = useCallback(
    (
      path: string,
      text: string,
      mtime: number | null,
      frontmatter: Record<string, unknown> | null,
      opts?: { isSystemSource?: boolean },
    ): void => {
      resetCounterRef.current += 1;
      const next: OpenDoc = {
        path,
        text,
        mtime,
        journalDate: journalDateOf(path),
        resetToken: resetCounterRef.current,
        frontmatter,
        isSystemSource: opts?.isSystemSource ?? false,
      };
      contentRef.current = text;
      dirtyRef.current = false;
      docRef.current = next;
      setDoc(next);
      setDirty(false);
      setSeek(null);
    },
    [],
  );

  // ---- SSE イベント処理 (Sd5c9f4-4) -------------------------------------------
  // pushToast / setOpenDoc の後に定義 (Story 6 で両方を依存に取るため)。

  /** SSE notes_changed: upsert→getNoteMeta で 1 件差分更新、delete→filter 除去。
   *
   * Story 6: upsert かつ changedPath が現在開いているノートのパスに一致するとき、
   * エディタ本文を最新内容へ自動更新する。
   * - dirty でない(未編集)の場合: 自動で本文を差し替える。スクロール/カーソル位置は
   *   CodeMirror の setOpenDoc が resetToken を変更し CodeMirror のリセットが走るため
   *   トップに戻る(現状の loadNote と同じ挙動)。
   * - dirty(編集中)の場合: ユーザーの未保存編集を破棄しないためトーストで通知して保留。
   *   リモート更新があったことを伝え、ユーザーが明示的に保存 or 破棄を選べる。
   */
  const handleSseNotesChanged = useCallback(
    (changedPath: string, op: 'upsert' | 'delete'): void => {
      if (op === 'delete') {
        setNotes((prev) => {
          if (prev === null) return prev;
          return prev.filter((n) => n.path !== changedPath);
        });
      } else {
        // upsert: getNoteMeta で最新情報を取得し NoteMeta へ変換してマージ
        api.getNoteMeta(changedPath).then(
          (meta) => {
            // NoteMetaResponse → NoteMeta 変換 (folder/title を path から導出)
            const folder = changedPath.includes('/')
              ? changedPath.slice(0, changedPath.lastIndexOf('/'))
              : '';
            const noteMeta: NoteMeta = {
              path: changedPath,
              title: noteTitle(changedPath),
              tags: meta.tags,
              folder,
              mtime: meta.mtime,
            };
            setNotes((prev) => {
              if (prev === null) return [noteMeta];
              const idx = prev.findIndex((n) => n.path === changedPath);
              let next: NoteMeta[];
              if (idx >= 0) {
                next = prev.map((n, i) => (i === idx ? noteMeta : n));
              } else {
                next = [...prev, noteMeta];
              }
              // パス昇順を維持
              return next.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
            });

            // Story 6: 現在開いているノートの場合、エディタ本文も更新する。
            if (docRef.current?.path === changedPath && previewRef.current === null) {
              if (dirtyRef.current) {
                // 編集中: 未保存編集を破棄しないためトーストで通知する (安全側)。
                // ユーザーは保存 (Ctrl+S) または「破棄して再読み込み」で対応できる。
                pushToast({
                  kind: 'error',
                  title: 'リモート変更があります',
                  sub: `${changedPath} がエージェントによって更新されました。保存または破棄してから再読み込みしてください。`,
                });
              } else {
                // 未編集: エディタ本文を自動更新する。
                api.getNote(changedPath).then(
                  (note) => {
                    // 再チェック: 取得完了後も同じノートが開かれているか確認
                    if (docRef.current?.path === changedPath && !dirtyRef.current) {
                      // 自己エコー抑制 (S6848dc review fix): 自分の autosave が chokidar→SSE で
                      // 戻ってきただけの場合、取得内容はエディタ現在値と一致する。setOpenDoc は
                      // 常に resetToken を更新し CodeMirror を全リセットする (カーソルが先頭へ飛び
                      // スクロールも失われる) ため、内容が同一なら再読込せずカーソル/スクロールを
                      // 保持する。真の外部変更 (内容差あり) のときだけ再読込する。
                      if (note.content === contentRef.current) {
                        // mtime だけ最新化 (次回保存の baseMtime 競合検出用)
                        if (docRef.current !== null) docRef.current = { ...docRef.current, mtime: note.mtime };
                        return;
                      }
                      setOpenDoc(note.path, note.content, note.mtime, note.frontmatter);
                    }
                  },
                  (err: unknown) => {
                    console.error('[loamium] SSE auto-reload getNote failed:', err);
                  },
                );
              }
            }
          },
          (err: unknown) => {
            // getNoteMeta 失敗時は全件再取得にフォールバック
            console.error('[loamium] SSE notes_changed getNoteMeta failed:', err);
            void refreshNotes();
          },
        );
      }
    },
    [refreshNotes, pushToast, setOpenDoc],
  );

  /** SSE sf_invalidated: 展開済み SF の再フェッチを SmartView に通知。
   *
   * 毎回新しい配列オブジェクトをセットすることで React が deps 変化として検知し
   * SmartFolder の useEffect が確実にトリガーされる。
   * setTimeout でのリセットは useEffect 実行前に呼ばれる場合があり NG (React 18 batching)。
   */
  const handleSseSfInvalidated = useCallback((ids: string[]): void => {
    setSseSfInvalidatedIds([...ids]);
  }, []);

  // SSE 購読 (Sd5c9f4-4)
  useVaultEvents({
    onSfInvalidated: handleSseSfInvalidated,
    onNotesChanged: handleSseNotesChanged,
  });

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
    async (path: string, opts?: { force?: boolean }): Promise<string | null> => {
      // force=true はリロード用: 同一パスでも再取得する (ヘッダのリロードボタン)。
      if (opts?.force !== true && docRef.current?.path === path && previewRef.current === null) return path;
      if (!(await saveNow())) return null;
      try {
        // ADR-0024: commands/*.yaml は notes API の .md 強制を回避して source エンドポイントで読む
        if (isCommandFile(path)) {
          const stem = path.split('/').at(-1)?.replace(/\.ya?ml$/i, '') ?? path;
          const res = await api.getCommandSource(stem);
          setPreview(null);
          setOpenDoc(res.path, res.content, res.mtime, null);
          setAppError(null);
          return res.path;
        }
        // Sa10026-9 #4: system/ 配下の設定ファイル (yaml / md) は system-files source 経由で読む
        if (isSystemSourceFile(path)) {
          const res = await api.getSystemFileSource(path);
          setPreview(null);
          setOpenDoc(res.path, res.content, res.mtime, null, { isSystemSource: true });
          setAppError(null);
          return res.path;
        }
        const res = await api.getNote(path);
        setPreview(null);
        setOpenDoc(res.path, res.content, res.mtime, res.frontmatter);
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
        setOpenDoc(res.path, res.content, res.mtime, res.frontmatter);
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
      // モバイルでノートを開いたらサイドバーを自動クローズ (AC-Sa6c3b0-1-6)
      setMobileSidebarOpen(false);
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
   * 設定ページ (/settings) へ遷移 (Sa10026-9 #2)。歯車から呼ぶ。履歴に積む。
   * 編集中のノートは保存し、text を同期してからルートを切り替える (戻るで復元)。
   */
  const showSettings = useCallback((): void => {
    void saveNow();
    setDoc((d) => (d !== null ? { ...d, text: contentRef.current } : d));
    setPreview(null);
    applyHistory({ kind: 'settings', group: null }, 'push');
  }, [applyHistory, saveNow]);

  /**
   * 設定グループの切替 (Sa100c6-nav)。各グループを URL (/settings/<group>) に載せて履歴に積む。
   * 戻る/進むでグループ間を移動でき、コンテンツ群は開くとサブメニューが隠れて戻るで戻れる。
   */
  const switchSettingsGroup = useCallback((group: SettingsGroup): void => {
    applyHistory({ kind: 'settings', group }, 'push');
  }, [applyHistory]);

  /**
   * 設定保存後に App 側の設定 state を再取得する (Sa10026-9 #7)。
   * defaultFolder / theme / showSystemFolder を一括再取得し、リロードなしで即反映する。
   * SettingsView の保存成功コールバック (onSaved) から呼ぶ。
   */
  const refreshAppSettings = useCallback((): void => {
    void api.getSystemSettings().then((s) => {
      setDefaultFolder(s.defaultFolder ?? '');
      setTheme(s.theme);
      setShowSystemFolder(s.showSystemFolder);
    });
  }, []);

  /**
   * ヘッダのリロードボタン: 現在のルートの内容をサーバーから再取得する。
   * - note: 開いているノート本文を強制再取得 (agent/外部エディタの変更を反映)。
   *   添付プレビュー表示中は添付/ノート一覧を最新化。
   * - files: ノート/添付一覧を再取得。
   * - settings / search: reloadToken を進めてページを再マウント (内部の取得をやり直す)。
   * いずれもサイドバーのツリー最新化のため refreshNotes を伴う。
   */
  const reloadCurrent = useCallback(async (): Promise<void> => {
    if (reloading) return;
    setReloading(true);
    try {
      const r = routeRef.current;
      if (r.kind === 'settings') {
        refreshAppSettings();
        setReloadToken((v) => v + 1);
        return;
      }
      if (r.kind === 'search') {
        setReloadToken((v) => v + 1);
        return;
      }
      if (r.kind === 'files') {
        await Promise.all([refreshNotes(), refreshFiles()]);
        return;
      }
      // note ルート
      void refreshNotes();
      if (previewRef.current !== null) {
        await refreshFiles();
        return;
      }
      const d = docRef.current;
      if (d !== null) await loadNote(d.path, { force: true });
    } finally {
      setReloading(false);
    }
  }, [reloading, refreshAppSettings, refreshNotes, refreshFiles, loadNote]);

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
   * タグクリック共通ハンドラ (S11493d-4)。
   * InfoPanel / properties.ts / dataview.ts / table.ts / Editor(onOpenTag) へ注入する。
   * openSearch を一度だけラップして作成 (openSearch が変わるたびに再生成される)。
   */
  const handleTagClick = useCallback(makeTagClickHandler(openSearch), [openSearch]);

  /**
   * 添付ファイルのプレビューを開く (Sf53ad6-2: ツリーの tree-file クリック)。
   * 開いているノートは保存してから切り替える (エディタは一時アンマウントされる)。
   * commands/*.yaml はコマンド定義ファイルなので FilePreview ではなく CommandEditor へ
   * ルーティングする (ADR-0024)。
   */
  const openFilePreview = useCallback(
    async (path: string): Promise<void> => {
      // ADR-0024: commands/*.yaml は CommandEditor で開く (FilePreview には渡さない)
      if (isCommandFile(path)) {
        await openNotePath(path);
        return;
      }
      if (!(await saveNow())) return;
      setDoc((d) => (d !== null ? { ...d, text: contentRef.current } : d));
      // /files ページ表示中に添付を選んだらノート領域 (プレビュー) へ戻す
      if (routeRef.current.kind !== 'note' && docRef.current !== null) {
        applyHistory({ kind: 'note', path: docRef.current.path }, 'push');
      }
      setPreview(path);
      setAppError(null);
    },
    [applyHistory, openNotePath, saveNow],
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
    void refreshSystemFiles();
    void refreshPropertyTypes();
    void refreshPropertyKeys();
    void refreshTags();
    // 設定取得: defaultFolder / theme / showSystemFolder の初期ロード (Sa10026-8 / graceful degradation)
    void api.getSystemSettings().then((s) => {
      setDefaultFolder(s.defaultFolder ?? '');
      setTheme(s.theme);
      setShowSystemFolder(s.showSystemFolder);
    });
    // サーバーモード取得: 設定画面の read-only 制御用 (Sa10026-7)
    void api.getHealth().then((h) => {
      setAppMode(h.mode);
    }).catch(() => { /* health fetch failure is non-fatal */ });
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
    } else if (r0.kind === 'settings') {
      applyHistory({ kind: 'settings', group: r0.group }, 'replace');
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
      } else if (r.kind === 'settings') {
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

  // ---- PWA インストールプロンプト (Sa6c3b0-4) ----
  // beforeinstallprompt をキャプチャしてカスタムプロンプトを表示する。
  useEffect(() => {
    const onBeforeInstall = (e: Event): void => {
      e.preventDefault();
      pwaInstallEventRef.current = e;
      setPwaPromptVisible(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  // ---- グローバルキー: Cmd/Ctrl+S (保存) / Cmd/Ctrl+K (検索) / F2 (リネーム) ----
  const modalOpenRef = useRef(false);
  modalOpenRef.current =
    dialog !== null ||
    conflictPath !== null ||
    menu !== null ||
    pickerOpen ||
    modalTemplate !== null;
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

  /**
   * ツリーをすべて展開する (ノート/スマート両対応)。ヘッダの全展開ボタンから呼ぶ。
   * 物理ビューは collapsedFolders を空にし、スマートビューは全行へ expand シグナルを送る。
   */
  const expandAllTree = useCallback((): void => {
    if (sidebarView === 'smart') {
      setSmartTreeSignal((s) => ({ action: 'expand', token: s.token + 1 }));
    } else {
      setCollapsedFolders(new Set());
    }
  }, [sidebarView]);

  /** ツリーをすべて折りたたむ (ノート/スマート両対応)。ヘッダの全折りたたみボタンから呼ぶ。 */
  const collapseAllTree = useCallback((): void => {
    if (sidebarView === 'smart') {
      setSmartTreeSignal((s) => ({ action: 'collapse', token: s.token + 1 }));
      return;
    }
    // 物理ビュー: 現在ツリーに現れる全フォルダ (system/ 含む) を折りたたむ。
    const folders = new Set<string>(collectFolderPaths(notes ?? [], extraFolders));
    if (showSystemFolder && systemFiles !== null) {
      for (const f of systemFiles) {
        const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        if (parent === '') continue;
        const parts = parent.split('/');
        for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
      }
    }
    setCollapsedFolders(folders);
  }, [sidebarView, notes, extraFolders, showSystemFolder, systemFiles]);

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
        setOpenDoc(res.path, '', res.mtime, null);
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

  // ---- テンプレート (S89a350-3) ----
  const refreshTemplates = useCallback(async (): Promise<void> => {
    try {
      setTemplates(await api.listTemplates());
      setTemplatesError(null);
    } catch (err) {
      setTemplatesError(errMessage(err));
    }
  }, []);

  /** 新規ノート ▸ 「テンプレートから新規作成」→ 一覧を取得して picker を開く。 */
  const openTemplatePicker = useCallback((): void => {
    setNewNoteMenuOpen(false);
    setMobileSidebarOpen(false);
    setTemplates(null);
    setTemplatesError(null);
    setPickerOpen(true);
    void refreshTemplates();
  }, [refreshTemplates]);

  /** スマートビュー ▸ 新規ファイル → テンプレートから (Sebf6b0-3 AC-3-3) */
  const openSmartNewFileTemplate = useCallback((): void => {
    setSmartNewFileMenuOpen(false);
    setDialog(null);
    setTemplates(null);
    setTemplatesError(null);
    setPickerOpen(true);
    void refreshTemplates();
  }, [refreshTemplates]);

  /**
   * スマートビュー ▸ 新規ファイル → 空のノート作成 (Sebf6b0-3 AC-3-2)。
   * フォルダ候補はノート一覧から derive する。
   */
  const loadSmartNewFileNotes = useCallback((): void => {
    if (smartNewFileNotes !== null) return;
    void api.listNotes().then(
      (res) => setSmartNewFileNotes(res.notes),
      () => setSmartNewFileNotes([]),
    );
  }, [smartNewFileNotes]);

  /**
   * 新規ノートダイアログ用のフォルダ候補を遅延ロードする (Sa10026-8)。
   * ノート一覧は既に refreshNotes() で取得済みの場合が多いが、
   * ダイアログが開く前にロードされていない場合に備えて API を呼ぶ。
   */
  const loadNewNoteNotes = useCallback((): void => {
    if (newNoteNotes !== null) return;
    // 既にロード済みのノート一覧を使い回す (API 節約)
    if (notes !== null) {
      setNewNoteNotes(notes);
      return;
    }
    void api.listNotes().then(
      (res) => setNewNoteNotes(res.notes),
      () => setNewNoteNotes([]),
    );
  }, [newNoteNotes, notes]);

  const createSmartNewNote = useCallback(async (): Promise<void> => {
    const trimPath = smartNewFilePath.trim();
    if (!trimPath) return;
    // パスに .md が付いていなければ追加する
    const notePath = trimPath.endsWith('.md') ? trimPath : `${trimPath}.md`;
    setDialog(null);
    setSmartNewFilePath('');
    setSmartNewFileNotes(null);
    try {
      const res = await api.putNote(notePath, '', 0);
      await refreshNotes();
      expandAncestors(dirnameOf(res.path));
      setOpenDoc(res.path, '', res.mtime, null);
      applyHistory({ kind: 'note', path: res.path }, 'push');
      setAppError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setAppError(`同名のノートが既に存在します — ${notePath}`);
        void refreshNotes();
      } else {
        setAppError(`ノートを作成できませんでした — ${errMessage(err)}`);
      }
    }
  }, [smartNewFilePath, applyHistory, expandAncestors, refreshNotes, setOpenDoc]);

  /**
   * 新規ノートダイアログ(統一) → ノート作成 (Sa10026-8)。
   * smart-newfile と同一の作成ロジックを共有する。
   * notePath は既に .md 付き (NewNoteDialog が補完済み)。
   */
  const createUnifiedNewNote = useCallback(
    async (notePath: string): Promise<void> => {
      setDialog(null);
      setNewNoteNotes(null);
      try {
        const res = await api.putNote(notePath, '', 0);
        await refreshNotes();
        expandAncestors(dirnameOf(res.path));
        setOpenDoc(res.path, '', res.mtime, null);
        applyHistory({ kind: 'note', path: res.path }, 'push');
        setAppError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setAppError(`同名のノートが既に存在します — ${notePath}`);
          void refreshNotes();
        } else {
          setAppError(`ノートを作成できませんでした — ${errMessage(err)}`);
        }
      }
    },
    [applyHistory, expandAncestors, refreshNotes, setOpenDoc],
  );

  /**
   * モーダル確定 → instantiate API → 解決先パス(衝突時は連番)に作成されたノートを開く。
   * 失敗 (不足変数の 4xx など) は throw して呼び出し元 (モーダル) がインライン表示する。
   */
  const createFromTemplate = useCallback(
    async (
      template: TemplateSummary,
      vars: Record<string, string>,
      date: string | undefined,
    ): Promise<void> => {
      const res = await api.instantiateTemplate(template.name, vars, date);
      setModalTemplate(null);
      setPickerOpen(false);
      await refreshNotes();
      expandAncestors(dirnameOf(res.path));
      await openNotePath(res.path);
      setAppError(null);
    },
    [expandAncestors, openNotePath, refreshNotes],
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
          setOpenDoc(note.path, note.content, note.mtime, note.frontmatter);
          // 開いているノート自身のリネーム → URL を新パスへ差替 (履歴は増やさない)
          applyHistory({ kind: 'note', path: note.path }, 'replace');
        } else if (openPath !== undefined && res.updatedNotes.some((u) => u.path === openPath)) {
          const note = await api.getNote(openPath);
          setOpenDoc(note.path, note.content, note.mtime, note.frontmatter);
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

  /**
   * フォルダ削除: 配下のノートをすべて逐次削除してから extraFolders からも除去する。
   * 既存の audited deleteNote API を再利用する (新エンドポイントは作らない)。
   */
  const deleteFolder = useCallback(
    async (folderPath: string): Promise<void> => {
      setDialog(null);
      const targets = (notes ?? []).filter(
        (n) => n.folder === folderPath || n.folder.startsWith(`${folderPath}/`),
      );
      try {
        for (const note of targets) {
          await api.deleteNote(note.path);
          // 削除したノートがエディタで開かれていれば閉じる
          if (docRef.current?.path === note.path) {
            docRef.current = null;
            contentRef.current = '';
            dirtyRef.current = false;
            setDoc(null);
            setDirty(false);
          }
        }
        // UI 合成の空フォルダも除去する
        setExtraFolders((prev) =>
          prev.filter((f) => f !== folderPath && !f.startsWith(`${folderPath}/`)),
        );
        await refreshNotes();
        setAppError(null);
      } catch (err) {
        setAppError(`フォルダを削除できませんでした — ${errMessage(err)}`);
        // 途中まで削除された場合でもノート一覧を最新化する
        await refreshNotes();
      }
    },
    [notes, refreshNotes],
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
          setOpenDoc(note.path, note.content, note.mtime, note.frontmatter);
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

  // ---- D&D 移動ハンドラ (S2e8a4c-3 / S2e8a4c-7 共用) ----

  /** ノート 1 件を targetFolder へ移動する */
  const handleDropNote = useCallback(
    async (sourcePath: string, targetFolder: string): Promise<void> => {
      try {
        await moveNote(sourcePath, targetFolder);
        onNotesChanged();
        // 開いているノートが移動された場合、新パスで再読み込み
        const basename = sourcePath.split('/').at(-1) ?? sourcePath;
        const newPath = targetFolder === '' ? basename : `${targetFolder}/${basename}`;
        if (docRef.current?.path === sourcePath) {
          const note = await api.getNote(newPath);
          setOpenDoc(note.path, note.content, note.mtime, note.frontmatter);
          applyHistory({ kind: 'note', path: note.path }, 'replace');
        }
        setAppError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          pushToast({ kind: 'error', title: '移動できませんでした', sub: '移動先に同名のノートが既に存在します' });
        } else {
          pushToast({ kind: 'error', title: '移動できませんでした', sub: errMessage(err) });
        }
      }
    },
    [applyHistory, onNotesChanged, pushToast, setOpenDoc],
  );

  /** フォルダを targetParent の下へ移動する (配下ノートを逐次 rename) */
  const handleDropFolder = useCallback(
    async (sourceFolder: string, targetParent: string): Promise<void> => {
      const currentNotes = notes ?? [];
      try {
        await moveFolder(currentNotes, sourceFolder, targetParent);
        onNotesChanged();
        setAppError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          pushToast({ kind: 'error', title: 'フォルダ移動できませんでした', sub: '移動先に同名のノートが既に存在します' });
        } else {
          pushToast({ kind: 'error', title: 'フォルダ移動できませんでした', sub: errMessage(err) });
        }
      }
    },
    [notes, onNotesChanged, pushToast],
  );

  // ---- ジャーナルナビゲーション ----
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
      if (d.isSystemSource) {
        const res = await api.getSystemFileSource(d.path);
        setOpenDoc(res.path, res.content, res.mtime, null, { isSystemSource: true });
      } else {
        const res = await api.getNote(d.path);
        setOpenDoc(res.path, res.content, res.mtime, res.frontmatter);
      }
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

  /**
   * commandHandlers を useMemo でメモ化し、パレット表示中のすべての App 再レンダーで
   * コマンドレジストリへの再登録が走るのを防ぐ (F-2)。
   * 依存配列: state setter は安定しているため含めない。
   */
  const commandHandlers = useMemo(
    () => ({
      onNewNote: () => {
        setPaletteOpen(false);
        setDialog({ type: 'new-note', folder: '' });
      },
      onOpenTemplatePicker: () => {
        setPaletteOpen(false);
        openTemplatePicker();
      },
      onNewSmartFolder: () => {
        setPaletteOpen(false);
        switchSidebarView('smart');
        setSmartAddTrigger((c) => c + 1);
      },
      onOpenAdvancedSearch: () => {
        setPaletteOpen(false);
        openSearch({ q: '', tag: '', folder: '', sort: 'updated' });
      },
      onOpenTodayJournal: () => {
        setPaletteOpen(false);
        void openJournalNav();
      },
      // リストタイプ変換 (S6848dc-6): パレットを閉じ、エディタにフォーカスを戻してから
      // 選択リストを変換する。変換ロジックは shared の convertListLines を共有する
      // Command (list-convert-cmd) を editorViewRef のビューに適用する。
      onConvertListToBullet: () => {
        setPaletteOpen(false);
        const view = editorViewRef.current;
        if (view !== null) {
          view.focus();
          convertListToBullet(view);
        }
      },
      onConvertListToOrdered: () => {
        setPaletteOpen(false);
        const view = editorViewRef.current;
        if (view !== null) {
          view.focus();
          convertListToOrdered(view);
        }
      },
    }),
    [openTemplatePicker, switchSidebarView, openSearch, openJournalNav],
  );

  return (
    <div className="app">
      {/* ================= 左: サイドバー (直近ファイル) ================= */}
      {/* モバイルスクリム: サイドバー外タップで閉じる (AC-Sa6c3b0-1-3) */}
      {mobileSidebarOpen && (
        <div
          className="sidebar-scrim"
          data-testid="sidebar-scrim"
          role="button"
          tabIndex={0}
          aria-label="サイドバーを閉じる"
          onClick={() => setMobileSidebarOpen(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setMobileSidebarOpen(false); }}
        />
      )}
      <aside
        className="sidebar"
        data-testid="sidebar"
        data-mobile-open={mobileSidebarOpen ? 'true' : 'false'}
      >
        <div className="sidebar-header">
          <div className="vault-badge">L</div>
          <div className="vault-name">Loamium</div>
          <span className="vault-version" title={`Loamium ${__APP_VERSION__}`}>
            {displayVersion(__APP_VERSION__)}
          </span>
          <button
            className="icon-btn"
            data-testid="sidebar-search"
            title="検索 (Ctrl+K)"
            onClick={() => setPaletteOpen(true)}
          >
            <SearchIcon />
          </button>
        </div>

        <JournalNav
          today={today}
          baseDate={journalBaseDate}
          onPrev={() => {
            if (journalBaseDate !== null) void openJournalNav(shiftJournalDate(journalBaseDate, -1));
          }}
          onNext={() => {
            if (journalBaseDate !== null) void openJournalNav(shiftJournalDate(journalBaseDate, 1));
          }}
          onToday={() => void openJournalNav()}
          onSelectDate={(date) => void openJournalNav(date)}
        />

        <div className="tree-section-title" data-testid="smart-view-header">
          <span
            className="sidebar-view-toggle"
            data-testid="sidebar-view-toggle"
            role="tablist"
            aria-label="サイドバー表示切替"
          >
            <button
              className={`sidebar-view-btn${sidebarView === 'physical' ? ' active' : ''}`}
              data-testid="sidebar-view-physical"
              aria-selected={sidebarView === 'physical'}
              aria-pressed={sidebarView === 'physical'}
              role="tab"
              title="物理フォルダビュー"
              onClick={() => switchSidebarView('physical')}
            >
              ノート
            </button>
            <button
              className={`sidebar-view-btn${sidebarView === 'smart' ? ' active' : ''}`}
              data-testid="sidebar-view-smart"
              aria-selected={sidebarView === 'smart'}
              aria-pressed={sidebarView === 'smart'}
              role="tab"
              title="スマートビュー"
              onClick={() => switchSidebarView('smart')}
            >
              スマート
            </button>
          </span>
          <div className="tree-actions">
            {/* ノート/スマート両対応: ツリー全展開・全折りたたみ (VSCode 風) */}
            <button
              className="icon-btn"
              data-testid="tree-expand-all"
              title="ツリーをすべて展開"
              aria-label="ツリーをすべて展開"
              onClick={expandAllTree}
            >
              <ExpandAllIcon />
            </button>
            <button
              className="icon-btn"
              data-testid="tree-collapse-all"
              title="ツリーをすべて折りたたむ"
              aria-label="ツリーをすべて折りたたむ"
              onClick={collapseAllTree}
            >
              <CollapseAllIcon />
            </button>
          {sidebarView === 'smart' && smartViewMode === 'full' && (
            <span className="actions" style={{ position: 'relative' }}>
              <button
                className="icon-btn"
                data-testid="smart-view-newfile"
                title="新規ファイルを作成"
                aria-haspopup="menu"
                aria-expanded={smartNewFileMenuOpen}
                onClick={() => setSmartNewFileMenuOpen((v) => !v)}
              >
                <NewNoteIcon />
              </button>
              <button
                className="icon-btn"
                data-testid="smart-view-add"
                title="スマートフォルダを追加"
                onClick={() => setSmartAddTrigger((c) => c + 1)}
              >
                <PlusIcon />
              </button>
              {smartNewFileMenuOpen && (
                <>
                  <div
                    className="newnote-menu-scrim"
                    onMouseDown={() => setSmartNewFileMenuOpen(false)}
                  />
                  <div
                    className="newnote-menu"
                    data-testid="smart-newfile-menu"
                    role="menu"
                    style={{ top: 26, right: 0 }}
                  >
                    <button
                      className="nm-item"
                      data-testid="smart-newfile-blank"
                      role="menuitem"
                      onClick={() => {
                        setSmartNewFileMenuOpen(false);
                        setSmartNewFilePath('');
                        setSmartNewFileNotes(null);
                        setDialog({ type: 'smart-newfile' });
                      }}
                    >
                      <DocumentIcon />
                      <span className="nm-main">
                        新規ファイル<span className="nm-sub">空のノートを作成</span>
                      </span>
                    </button>
                    <div className="nm-sep" />
                    <button
                      className="nm-item"
                      data-testid="smart-newfile-template"
                      role="menuitem"
                      onClick={openSmartNewFileTemplate}
                    >
                      <DocumentIcon />
                      <span className="nm-main">
                        テンプレートから<span className="nm-sub">templates/ から選ぶ</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </span>
          )}
          {sidebarView === 'physical' && (
            <span className="actions" style={{ position: 'relative' }}>
              <button
                className="icon-btn"
                data-testid="sidebar-new-note"
                title="新規ノート"
                aria-haspopup="menu"
                aria-expanded={newNoteMenuOpen}
                onClick={() => setNewNoteMenuOpen((v) => !v)}
              >
                <NewNoteIcon />
              </button>
              <button
                className="icon-btn"
                data-testid="sidebar-new-folder"
                title="新規フォルダ"
                onClick={() => setDialog({ type: 'new-folder', parent: selectedFolder })}
              >
                <NewFolderIcon />
              </button>
              {newNoteMenuOpen && (
                <>
                  <div className="newnote-menu-scrim" onMouseDown={() => setNewNoteMenuOpen(false)} />
                  <div
                    className="newnote-menu"
                    data-testid="new-note-menu"
                    role="menu"
                    style={{ top: 26, right: 0 }}
                  >
                    <button
                      className="nm-item"
                      data-testid="new-note-menu-blank"
                      role="menuitem"
                      onClick={() => {
                        setNewNoteMenuOpen(false);
                        setDialog({ type: 'new-note', folder: selectedFolder });
                      }}
                    >
                      <DocumentIcon />
                      <span className="nm-main">
                        空のノート<span className="nm-sub">見出しのみの新規ノート</span>
                      </span>
                    </button>
                    <div className="nm-sep" />
                    <button
                      className="nm-item"
                      data-testid="new-note-menu-template"
                      role="menuitem"
                      onClick={openTemplatePicker}
                    >
                      <DocumentIcon />
                      <span className="nm-main">
                        テンプレートから新規作成
                        <span className="nm-sub">templates/ から選ぶ</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </span>
          )}
          </div>
        </div>

        {sidebarView === 'smart' ? (
          <SmartView
            onOpenNote={(path) => void openNotePath(path)}
            onSwitchToPhysical={() => switchSidebarView('physical')}
            triggerAdd={smartAddTrigger}
            onModeChange={setSmartViewMode}
            commandSaveToken={commandSaveToken}
            invalidatedIds={sseSfInvalidatedIds}
            treeSignal={smartTreeSignal}
          />
        ) : (
          <>
            {/* system/ フォルダはクライアント側でフィルタ (AC-Sa10026-4-1) */}
            <FileTree
              notes={notes === null ? null : notes.filter((n) => !n.folder.startsWith('system'))}
              extraFolders={extraFolders}
              activePath={activeSidebarPath}
              collapsed={collapsedFolders}
              error={notesError}
              onToggleFolder={toggleFolder}
              onSelectFolder={setSelectedFolder}
              onOpenNote={(path) => void openNotePath(path)}
              onContextMenuNote={onContextMenuNote}
              onContextMenuFolder={onContextMenuFolder}
              onDropNote={(src, tgt) => void handleDropNote(src, tgt)}
              onDropFolder={(src, tgt) => void handleDropFolder(src, tgt)}
            />
            {/* system/ ネストフォルダツリー (showSystemFolder=true のときのみ表示) */}
            {showSystemFolder && (
              <SystemFolderSection
                systemFiles={systemFiles}
                activePath={activeSidebarPath}
                collapsed={collapsedFolders}
                onToggleFolder={toggleFolder}
                onOpenNote={(path) => void openNotePath(path)}
              />
            )}
          </>
        )}

        {/* 最下部バー (Sa10026-9 #3): 左=歯車(設定) / 右=フォルダ(すべてのファイル) */}
        <div className="sidebar-bottom-bar" data-testid="sidebar-bottom-bar">
          <button
            className={`sidebar-bottom-btn${route.kind === 'settings' ? ' active' : ''}`}
            data-testid="sidebar-settings"
            title="設定"
            aria-current={route.kind === 'settings' ? 'page' : undefined}
            onClick={showSettings}
          >
            <GearIcon />
          </button>
          <button
            className={`sidebar-bottom-btn${route.kind === 'files' ? ' active' : ''}`}
            data-testid="sidebar-show-all"
            title="すべてのファイル (画像・PDF・添付を含む)"
            aria-current={route.kind === 'files' ? 'page' : undefined}
            onClick={showFiles}
          >
            <FolderIcon />
          </button>
        </div>
      </aside>

      {/* ================= 中央: メイン 1 画面 ================= */}
      <main className="workspace">
        <div className="editor-header">

          {/* モバイルハンバーガーボタン (AC-Sa6c3b0-1-2) */}
          <button
            className={`sidebar-toggle-btn${mobileSidebarOpen ? ' open' : ''}`}
            data-testid="sidebar-toggle"
            aria-label={mobileSidebarOpen ? 'サイドバーを閉じる' : 'サイドバーを開く'}
            aria-expanded={mobileSidebarOpen}
            onClick={() => setMobileSidebarOpen((v) => !v)}
          >
            <MenuIcon />
          </button>
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
            {/* リロード: 現在の画面 (ノート/ファイル一覧/設定/検索) をサーバーから再取得。
                戻る/進むと同じナビ操作グループにまとめる (ブラウザ標準の < > ⟳ 並び)。 */}
            <button
              className="nav-btn reload-btn"
              data-testid="header-reload"
              title="再読み込み (現在の画面をサーバーから取得し直す)"
              aria-label="再読み込み"
              disabled={reloading}
              onClick={() => void reloadCurrent()}
            >
              <ReloadIcon className={reloading ? 'spinning' : ''} />
            </button>
          </div>
          <nav className="route-crumbs breadcrumb" data-testid="route-display" aria-label="現在のルート">
            {route.kind === 'files' ? (
              <span className="route-token">/files</span>
            ) : route.kind === 'settings' ? (
              <>
                <span className="route-token">/settings</span>
                {route.group !== null && (
                  <>
                    <span className="sep">/</span>
                    <span className="current">{route.group}</span>
                  </>
                )}
              </>
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
          {route.kind === 'note' && doc !== null && preview === null && !isCommandFile(doc.path) && (
            <div className="save-status" data-testid="save-status" data-state={dirty ? 'dirty' : 'saved'}>
              <span className="dot" />
              <span>{dirty ? '未保存' : '保存済み'}</span>
            </div>
          )}
          {route.kind === 'note' && doc !== null && preview === null && !doc.isSystemSource && (
            <BookmarkStar
              key={doc.path}
              docPath={doc.path}
              initialFrontmatter={doc.frontmatter}
              onChanged={() => {
                const currentDoc = docRef.current;
                if (currentDoc === null) return;
                void api.getNote(currentDoc.path).then(
                  (res) => { setOpenDoc(res.path, res.content, res.mtime, res.frontmatter); },
                  () => { /* ノート再取得失敗時はエディタ表示をそのまま維持する */ },
                );
              }}
            />
          )}
        </div>

        {route.kind === 'settings' ? (
          <SettingsView
            key={`settings-${String(reloadToken)}`}
            mode={appMode}
            group={route.group}
            onSwitchGroup={switchSettingsGroup}
            onClose={() => {
              // 履歴があれば戻る (エディタへ)。無ければ開いているノート or ジャーナルへ。
              if (canBack) window.history.back();
              else if (doc !== null) applyHistory({ kind: 'note', path: doc.path }, 'push');
              else void openJournalNav();
            }}
            onSaved={refreshAppSettings}
          />
        ) : route.kind === 'search' ? (
          <SearchPage
            key={`search-${String(reloadToken)}`}
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
        ) : doc !== null && isCommandFile(doc.path) ? (
          <CommandEditor
            docPath={doc.path}
            content={doc.text}
            resetToken={doc.resetToken}
            mtime={doc.mtime}
            onChange={onCommandEditorChange}
            onSaved={(mtime) => {
              markSaved(doc.path, mtime);
              // CommandEditor が独自保存した後 App の dirty/contentRef も整合させる
              dirtyRef.current = false;
              setDirty(false);
              if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
              }
              void refreshTags();
              void refreshPropertyKeys();
              setBacklinksToken((v) => v + 1);
              // スマートビューのコマンド一覧を最新化する
              setCommandSaveToken((v) => v + 1);
            }}
            onSaveError={(msg) => setAppError(`保存に失敗しました — ${msg}`)}
          />
        ) : doc !== null ? (
          <Editor
            docPath={doc.path}
            content={doc.text}
            resetToken={doc.resetToken}
            seek={seek}
            notes={notes}
            files={files}
            propertyTypes={propertyTypes}
            propertyKeys={propertyKeys}
            onPersistPropertyType={onPersistPropertyType}
            tags={tags}
            onChange={onEditorChange}
            onSave={() => void saveNow()}
            onOpenNote={(path) => void openNotePath(path)}
            onOpenNoteAtLine={(path, line) => void openNoteAtLine(path, line)}
            onCreateAndOpenNote={(target) => void createNoteFromLink(target, true)}
            onCreateNote={(target) => void createNoteFromLink(target, false)}
            onOpenTag={handleTagClick}
            onUploadFiles={uploadFiles}
            onDragActive={setDragActive}
            onViewReady={(view) => { editorViewRef.current = view; }}
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
            <div className="smart-folder-guide" data-testid="smart-folder-guide">
              <h3>スマートフォルダの使い方</h3>
              <ul>
                <li>
                  <strong>スマートビュー切替</strong> — サイドバー上部の「スマート」タブを選ぶと
                  スマートビューに切り替わります。
                </li>
                <li>
                  <strong>スマートフォルダ作成</strong> — スマートビューの <code>+</code> ボタンで
                  クエリ（最近更新・タグ・未完了 TODO など）または
                  ピン留め（ノート・フォルダ）を追加できます。
                </li>
                <li>
                  <strong>ブックマーク ★</strong> — 開いているノートのヘッダの ★ を押すと
                  そのノートをブックマーク登録できます。スマートビューで一覧できます。
                </li>
              </ul>
            </div>
            <div className="smart-command-guide" data-testid="smart-command-guide">
              <h3>スマートコマンドの使い方</h3>
              <ul>
                <li>
                  <strong>定義を書く</strong> — <code>commands/</code> フォルダにノートを作成し、
                  frontmatter に <code>loamium-command:</code> ブロックを追加します。
                  ノートを開くと自動で定義エディタ（スプリットビュー）に切り替わります。
                </li>
                <li>
                  <strong>コマンドパレットで実行</strong> — <kbd>Ctrl</kbd>+<kbd>K</kbd> を押して{' '}
                  <code>{'>'}</code> を入力すると、登録済みスマートコマンドの一覧が表示されます。
                  選択するとフォームが開き、パラメータを入力して実行できます。
                </li>
                <li>
                  <strong>定義エディタで編集</strong> — 左ペインで YAML を直接編集し、
                  右ペインでライブ検証・プレビュー・テスト実行ができます。
                  補完（<kbd>Ctrl</kbd>+<kbd>Space</kbd>）で <code>kind:</code> やパラメータトークン{' '}
                  <code>{'{{param}}'}</code> を素早く入力できます。
                </li>
              </ul>
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

        {/* PWA インストールプロンプト (AC-Sa6c3b0-4) */}
        {pwaPromptVisible && (
          <div
            className="pwa-install-prompt"
            data-testid="pwa-install-prompt"
            role="dialog"
            aria-label="Loamium をホーム画面に追加"
          >
            <div className="pwa-icon" aria-hidden="true">L</div>
            <div className="pwa-text">
              <strong>ホーム画面に追加</strong>
              <span>Loamium をアプリとして使えます。オフラインでも UI が表示されます。</span>
            </div>
            <div className="pwa-actions">
              <button
                className="pwa-install-btn"
                data-testid="pwa-install-btn"
                aria-label="ホーム画面に追加する"
                onClick={() => {
                  const evt = pwaInstallEventRef.current;
                  if (evt !== null && 'prompt' in evt && typeof (evt as { prompt: () => void }).prompt === 'function') {
                    (evt as { prompt: () => void }).prompt();
                  }
                  setPwaPromptVisible(false);
                }}
              >
                追加
              </button>
              <button
                className="pwa-dismiss-btn"
                data-testid="pwa-dismiss-btn"
                aria-label="後で"
                onClick={() => setPwaPromptVisible(false)}
              >
                後で
              </button>
            </div>
          </div>
        )}

        {/* ボトムナビゲーションバー (AC-Sa6c3b0-6-1) */}
        <nav className="mobile-bottom-nav" data-testid="mobile-bottom-nav" aria-label="メインナビゲーション">
          <button
            className={`mobile-nav-item${!mobileAgentSheetOpen ? ' active' : ''}`}
            data-testid="mobile-nav-notes"
            aria-label="ノート"
            onClick={() => setMobileAgentSheetOpen(false)}
          >
            <NoteNavIcon />
            <span className="nav-label">ノート</span>
          </button>
          <button
            className="mobile-nav-item"
            data-testid="mobile-nav-search"
            aria-label="検索"
            onClick={() => {
              setMobileAgentSheetOpen(false);
              setPaletteOpen(true);
            }}
          >
            <SearchIcon />
            <span className="nav-label">検索</span>
          </button>
          <button
            className={`mobile-nav-item${mobileAgentSheetOpen ? ' active' : ''}`}
            data-testid="mobile-nav-agent"
            aria-label="Agent を開く"
            onClick={() => setMobileAgentSheetOpen(true)}
          >
            <AgentNavIcon />
            <span className="nav-label">Agent</span>
          </button>
        </nav>
      </main>

      {/* ================= モバイル Agent フルスクリーンシート (AC-Sa6c3b0-6-2) ================= */}
      <MobileAgentSheet
        open={mobileAgentSheetOpen}
        currentNotePath={doc?.path ?? null}
        notes={notes}
        onOpenNote={(path) => {
          setMobileAgentSheetOpen(false);
          void openNotePath(path);
        }}
        onNotesChanged={onNotesChanged}
        onClose={() => setMobileAgentSheetOpen(false)}
      />

      {/* ================= 右: サイドバー (インフォ | Agent) ================= */}
      {/* /search では非表示 (AC-Sa629e2-3-3)。unmount しない — セッション/スクロール維持 */}
      <RightSidebar
        notePath={route.kind === 'note' ? (doc?.path ?? null) : null}
        refreshToken={backlinksToken}
        onOpenNote={(path) => void openNotePath(path)}
        onJumpToLine={(line) => {
          // 現在のノートの指定行へジャンプ (Outline クリック)。
          // 別ノートへは遷移しない — 常に開いているノート内スクロール。
          // Sb6f1d3-2: 対象行が fold 状態なら unfoldEffect で展開してからスクロール。
          if (doc !== null) {
            const view = editorViewRef.current;
            if (view !== null) {
              // 対象行の from 位置を含む foldedRanges を全て展開
              const targetLine = Math.min(Math.max(1, line), view.state.doc.lines);
              const pos = view.state.doc.line(targetLine).from;
              const effects: ReturnType<typeof unfoldEffect.of>[] = [];
              foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
                // fold 範囲が pos を含むか、pos が range の直後 (見出し行末 = from)
                if (from <= pos && pos <= to) {
                  effects.push(unfoldEffect.of({ from, to }));
                }
              });
              if (effects.length > 0) {
                view.dispatch({ effects });
              }
            }
            seekCounterRef.current += 1;
            setSeek({ line, token: seekCounterRef.current });
          }
        }}
        onSearchTag={handleTagClick}
        hidden={route.kind === 'search'}
        forceCollapsed={route.kind === 'settings'}
        notes={notes}
        onNotesChanged={onNotesChanged}
        currentNotePath={doc?.path ?? null}
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
          commandHandlers={commandHandlers}
          onNotesChanged={onNotesChanged}
        />
      )}

      {pickerOpen && (
        <TemplatePicker
          templates={templates}
          error={templatesError}
          onSelect={(t) => {
            setPickerOpen(false);
            setModalTemplate(t);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {modalTemplate !== null && (
        <TemplateModal
          template={modalTemplate}
          onCreate={(vars, date) => createFromTemplate(modalTemplate, vars, date)}
          onCancel={() => {
            // モーダルを閉じて picker へ戻す (prototype: 中断で選択へ戻る)
            const t = modalTemplate;
            setModalTemplate(null);
            if (t !== null) setPickerOpen(true);
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
          {...(menu.kind === 'folder' ? {
            onDeleteFolder: () => {
              const folderPath = menu.path;
              // 配下ノート数を計算して確認ダイアログへ
              const noteCount = (notes ?? []).filter(
                (n) => n.folder === folderPath || n.folder.startsWith(`${folderPath}/`),
              ).length;
              setMenu(null);
              setDialog({ type: 'delete-folder', folderPath, noteCount });
            },
          } : {})}
          {...(menu.kind !== 'attachment' ? {
            onMove: () => {
              setMenu(null);
              setDialog({ type: 'move', path: menu.path, isFolder: menu.kind === 'folder' });
            }
          } : {})}
          onClose={() => setMenu(null)}
        />
      )}

      {dialog?.type === 'new-note' && (
        <NewNoteDialog
          initialPath={
            // フォルダ指定あり (コンテキストメニュー等) → そのフォルダを prefill
            // フォルダ指定なし → defaultFolder を prefill (空なら空文字)
            dialog.folder !== ''
              ? `${dialog.folder}/`
              : defaultFolder !== ''
                ? `${defaultFolder}/`
                : ''
          }
          notes={newNoteNotes}
          defaultFolder={dialog.folder !== '' ? '' : defaultFolder}
          onConfirm={(notePath) => void createUnifiedNewNote(notePath)}
          onCancel={() => {
            setDialog(null);
            setNewNoteNotes(null);
          }}
          onRequestNotes={loadNewNoteNotes}
        />
      )}

      {dialog?.type === 'smart-newfile' && (() => {
        // フォルダ候補: SmartFolderForm と同じ deriveFolderCandidates を再利用
        const q = smartNewFilePath.toLowerCase().trim();
        const folderCandidates: string[] = smartNewFileNotes === null
          ? []
          : (() => {
              const folderSet = new Set<string>();
              for (const note of smartNewFileNotes) {
                const f = note.folder;
                if (f === '') continue;
                const parts = f.split('/');
                for (let i = 1; i <= parts.length; i++) {
                  folderSet.add(parts.slice(0, i).join('/'));
                }
              }
              return Array.from(folderSet).sort();
            })();
        const filteredFolders = folderCandidates
          .filter((f) => q.length === 0 || f.toLowerCase().includes(q))
          .slice(0, 15);
        return (
          <div className="dialog-backdrop" data-testid="smart-newfile-dialog" role="dialog" aria-modal="true">
            <div className="dialog" onClick={(e) => e.stopPropagation()}>
              <h2>新規ファイル</h2>
              <div className="dialog-body">
                <div className="sf-form-combobox" style={{ position: 'relative' }}>
                  <input
                    type="text"
                    className="dialog-input"
                    data-testid="smart-newfile-path"
                    placeholder="folder/note-name (拡張子 .md は自動補完)"
                    value={smartNewFilePath}
                    autoFocus
                    onFocus={() => {
                      if (smartNewFilePathBlurRef.current !== null) clearTimeout(smartNewFilePathBlurRef.current);
                      loadSmartNewFileNotes();
                      setSmartNewFilePathOpen(true);
                    }}
                    onBlur={() => {
                      smartNewFilePathBlurRef.current = setTimeout(() => setSmartNewFilePathOpen(false), 150);
                    }}
                    onChange={(e) => {
                      setSmartNewFilePath(e.target.value);
                      setSmartNewFilePathOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createSmartNewNote();
                      if (e.key === 'Escape') {
                        setDialog(null);
                        setSmartNewFilePath('');
                        setSmartNewFileNotes(null);
                      }
                    }}
                  />
                  {smartNewFilePathOpen && filteredFolders.length > 0 && (
                    <div className="sf-form-dropdown">
                      {filteredFolders.map((folder) => (
                        <button
                          key={folder}
                          type="button"
                          className="sf-form-option"
                          data-testid="smart-newfile-path-option"
                          data-path={folder}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSmartNewFilePath(folder + '/');
                            setSmartNewFilePathOpen(false);
                            if (smartNewFilePathBlurRef.current !== null) clearTimeout(smartNewFilePathBlurRef.current);
                          }}
                        >
                          <span>{folder}/</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="smart-newfile-cancel"
                  onClick={() => {
                    setDialog(null);
                    setSmartNewFilePath('');
                    setSmartNewFileNotes(null);
                  }}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  className="btn primary"
                  data-testid="smart-newfile-create"
                  disabled={smartNewFilePath.trim() === ''}
                  onClick={() => void createSmartNewNote()}
                >
                  作成
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

      {dialog?.type === 'delete-folder' && (
        <DeleteFolderDialog
          folderPath={dialog.folderPath}
          noteCount={dialog.noteCount}
          onConfirm={() => void deleteFolder(dialog.folderPath)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === 'move' && (
        <MoveDialog
          targetName={dialog.path.split('/').at(-1) ?? dialog.path}
          notes={notes}
          onConfirm={(targetFolder) => {
            const { path, isFolder } = dialog;
            setDialog(null);
            if (isFolder) {
              // フォルダ移動: sourceFolder の basename が同じなら no-op
              const folderBasename = path.split('/').at(-1) ?? path;
              const newParent = targetFolder === '' ? folderBasename : `${targetFolder}/${folderBasename}`;
              if (newParent === path) return; // 同じ場所
              void handleDropFolder(path, targetFolder);
            } else {
              void handleDropNote(path, targetFolder);
            }
          }}
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
