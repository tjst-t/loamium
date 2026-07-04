/**
 * Loamium UI ルート。3 ペイン (サイドバー / エディタ / バックリンクパネル)。
 *
 * - 起動時に GET /api/journal で今日のジャーナルを開く (DESIGN_PRINCIPLES ui_ux)。
 * - 保存は Cmd/Ctrl+S + デバウンス自動保存。PUT には baseMtime を添え、
 *   409 conflict は警告ダイアログ (上書き / 再読込) を出す (SPEC §9 高-1)。
 * - ファイルはピュア Markdown のまま (priority 1) — UI は content 文字列しか送らない。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react';
import { isValidJournalDate, shiftJournalDate, type FileMeta, type NoteMeta } from '@loamium/shared';
import { api, ApiError } from './api.js';
import { buildTree } from './tree.js';
import { formatSize } from './file-kind.js';
import { Editor } from './components/Editor.js';
import { FilePreview } from './components/FilePreview.js';
import { TerminalPane, type TerminalStatus } from './components/TerminalPane.js';
import { FileTree } from './components/FileTree.js';
import { JournalNav } from './components/JournalNav.js';
import { BacklinkPanel } from './components/BacklinkPanel.js';
import { ContextMenu } from './components/ContextMenu.js';
import { ConflictDialog, DeleteDialog, NameDialog } from './components/dialogs.js';
import { SearchPalette } from './components/SearchPalette.js';
import {
  CheckCircleIcon,
  CloseIcon,
  DocumentIcon,
  GearIcon,
  LinkIcon,
  NewFolderIcon,
  NewNoteIcon,
  SearchIcon,
  TerminalIcon,
  UploadIcon,
  WarnTriangleIcon,
} from './icons.js';

const AUTOSAVE_DEBOUNCE_MS = 1500;
const JOURNAL_FILE_RE = /^journals\/(\d{4}-\d{2}-\d{2})\.md$/;

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
  | { type: 'new-folder' }
  | { type: 'rename'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename-file'; path: string }
  | { type: 'delete-file'; path: string }
  | null;

interface MenuState {
  x: number;
  y: number;
  path: string;
  kind: 'folder' | 'note' | 'attachment';
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
  // ---- サイドバー: ノート一覧とツリー ----
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // ---- 添付ファイル (Sf53ad6-2): ツリー表示・プレビュー・アップロード ----
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [toasts, setToasts] = useState<UploadToast[]>([]);

  // ---- エディタ / 保存 ----
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);

  // ---- ジャーナル ----
  const [today, setToday] = useState<string | null>(null);
  const [journalListOpen, setJournalListOpen] = useState(false);

  // ---- ポップアップ ----
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // ---- 検索パレット (Sbd061c-1) ----
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 全文ヒット確定時のカーソル移動指示 (Editor の seek prop へ) */
  const [seek, setSeek] = useState<{ line: number; token: number } | null>(null);
  const seekCounterRef = useRef(0);
  /** 保存成功のたびに増える — バックリンクパネルの再取得トリガー (S6fbf45-2) */
  const [backlinksToken, setBacklinksToken] = useState(0);

  // ---- ターミナルタブ (Sb7f458-2 — prototype/terminal.html) ----
  const [workspaceTab, setWorkspaceTab] = useState<'editor' | 'terminal'>('editor');
  /** 一度開いたら unmount しない (タブ切替でセッションを切らない) */
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('loading');
  const [terminalCmd, setTerminalCmd] = useState<string | null>(null);

  const docRef = useRef<OpenDoc | null>(null);
  const contentRef = useRef('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetCounterRef = useRef(0);
  docRef.current = doc;

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
      // 添付一覧が取れなくてもノート編集は妨げない (ツリーはノートのみ表示)
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
        // 完了系は自動で消える (× でも消せる)。エラーは長めに残す
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
        setBacklinksToken((v) => v + 1); // 保存でバックリンクパネルを更新
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
    // ドキュメントを開き直すたびにカーソル移動指示をリセットする。Editor の
    // 再マウント時に古い seek が再適用されるのを防ぐ (レビュー R1)。
    // openNoteAtLine は setOpenDoc の後に setSeek するため、全文ヒットでは上書きされる。
    setSeek(null);
    // ターミナル表示中にノートを開いたらエディタタブへ戻す (Sb7f458-2)
    setWorkspaceTab('editor');
  }, []);

  const openNotePath = useCallback(
    async (path: string): Promise<void> => {
      if (docRef.current?.path === path) {
        setPreview(null); // プレビュー表示中に同じノートへ戻るケース
        return;
      }
      if (!(await saveNow())) return; // 競合/失敗中はノートを切り替えない
      try {
        const res = await api.getNote(path);
        setPreview(null);
        setOpenDoc(res.path, res.content, res.mtime);
        setAppError(null);
      } catch (err) {
        setAppError(`ノートを開けませんでした — ${errMessage(err)}`);
      }
    },
    [saveNow, setOpenDoc],
  );

  /**
   * 添付ファイルのプレビューを開く (Sf53ad6-2: ツリーの tree-file クリック)。
   * 開いているノートは保存してから切り替える (エディタは一時アンマウントされる)。
   */
  const openFilePreview = useCallback(
    async (path: string): Promise<void> => {
      if (!(await saveNow())) return;
      // エディタ再マウント時に最新の編集内容から復元できるよう text を同期する
      setDoc((d) => (d !== null ? { ...d, text: contentRef.current } : d));
      setPreview(path);
      setAppError(null);
      setWorkspaceTab('editor');
    },
    [saveNow],
  );

  /**
   * [[リンク]] からのノート作成 (S6fbf45-1)。
   * - 壊れリンクのクリック: open=true (作成して開く)
   * - オートコンプリートの「作成してリンク」: open=false (作成のみ、執筆を中断しない)
   * baseMtime: 0 の create-only PUT なので既存ノートを上書きしない (priority 2)。
   */
  const createNoteFromLink = useCallback(
    async (target: string, open: boolean): Promise<void> => {
      const t = target.trim().normalize('NFC');
      if (t.length === 0) return;
      if (/\.[A-Za-z0-9]+$/.test(t) && !/\.md$/i.test(t)) {
        // [[image.png]] 等の非 Markdown ターゲットを "image.png.md" として
        // 作成してしまわない (レビュー指摘 R1 — 添付参照はノート作成対象外)
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
        // 409 = 既に存在 (外部で作成済み等)。リンク先はあるので続行してよい
      }
      void refreshNotes();
      if (open) await openNotePath(rel);
    },
    [openNotePath, refreshNotes],
  );

  /**
   * 全文検索ヒットの確定 (Sbd061c-1): ノートを開き、該当行へカーソルを移動する。
   * openNotePath が失敗 (競合・404 等) した場合はカーソル移動しない。
   */
  const openNoteAtLine = useCallback(
    async (path: string, line: number): Promise<void> => {
      await openNotePath(path);
      if (docRef.current?.path !== path) return; // 開けなかった (保存競合・エラー)
      seekCounterRef.current += 1;
      setSeek({ line, token: seekCounterRef.current });
    },
    [openNotePath],
  );

  const openJournal = useCallback(
    async (date?: string): Promise<void> => {
      if (!(await saveNow())) return;
      try {
        const res = await api.getJournal(date);
        setPreview(null);
        setOpenDoc(res.path, res.content, res.mtime);
        if (date === undefined) setToday(res.date);
        if (res.created) void refreshNotes();
        setAppError(null);
      } catch (err) {
        setAppError(`ジャーナルを開けませんでした — ${errMessage(err)}`);
      }
    },
    [refreshNotes, saveNow, setOpenDoc],
  );

  // ---- 起動: ツリー読み込み + 今日のジャーナルへ着地 ----
  const didInitRef = useRef(false);
  useEffect(() => {
    // StrictMode の二重マウントでも起動処理は一度だけ (ジャーナル二重取得を防ぐ)
    if (didInitRef.current) return;
    didInitRef.current = true;
    void refreshNotes();
    void refreshFiles();
    void openJournal();
    // 起動時に一度だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- グローバルキー: Cmd/Ctrl+S (保存) / Cmd/Ctrl+K (検索パレット) / F2 (リネーム) ----
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
        // ダイアログ・メニュー表示中は奪わない。表示中の再押下は SearchPalette 側が処理
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
        // ダイアログ・メニュー・パレット表示中は F2 で状態を奪わない
        e.preventDefault();
        setDialog({ type: 'rename', path: docRef.current.path });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNow]);

  // ---- ツリー操作 ----
  const tree = useMemo(
    () => buildTree(notes ?? [], files ?? [], extraFolders),
    [notes, files, extraFolders],
  );

  const toggleFolder = useCallback((path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onTreeContextMenu = useCallback(
    (e: MouseEvent, path: string, kind: 'folder' | 'note' | 'attachment'): void => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, path, kind });
    },
    [],
  );

  const notePaths = useMemo(() => new Set((notes ?? []).map((n) => n.path)), [notes]);

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
        // baseMtime: 0 = create-only。ツリーが古く、同名ノートが外部 (エージェント等) で
        // 既に作られていた場合は 409 になり、黙って上書きしない (データ安全性 priority 2)。
        const res = await api.putNote(path, '', 0);
        await refreshNotes();
        setOpenDoc(res.path, '', res.mtime);
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
    [refreshNotes, setOpenDoc],
  );

  const renameNote = useCallback(
    async (oldPath: string, newName: string): Promise<void> => {
      const folder = dirnameOf(oldPath);
      const newPath = folder === '' ? `${newName}.md` : `${folder}/${newName}.md`;
      setDialog(null);
      if (newPath === oldPath) return;
      try {
        // 未保存編集を先に反映してから rename API に任せる:
        // vault 全体の [[旧名]] 追従・監査ログ・409 保護はサーバー側 (S6fbf45-3)
        if (!(await saveNow())) return;
        const res = await api.renameNote(oldPath, newPath);
        await refreshNotes();
        const openPath = docRef.current?.path;
        if (openPath === oldPath) {
          // 開いているノート自身のリネーム: 新パスで開き直す (自己リンク書き換えも反映)
          const note = await api.getNote(res.path);
          setOpenDoc(note.path, note.content, note.mtime);
        } else if (openPath !== undefined && res.updatedNotes.some((u) => u.path === openPath)) {
          // 開いているノートがリンク書き換え対象: ディスクの新内容を読み直す
          // (保存済みなので編集は失われない。放置すると次回保存が 409 になる)
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
    [refreshNotes, saveNow, setOpenDoc],
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

  const createFolder = useCallback((name: string): void => {
    setDialog(null);
    setExtraFolders((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }, []);

  // ---- 添付ファイル: アップロード / リネーム / 削除 (Sf53ad6-2) ----

  /** アップロード名のサニタイズ (パス区切り除去・NFC・隠しファイル名回避)。 */
  const sanitizeUploadName = useCallback((raw: string, mime: string): string => {
    let name = (raw.split(/[\\/]/).pop() ?? '').trim().normalize('NFC').replace(/^\.+/, '');
    if (name === '') {
      // クリップボード画像等の無名ファイルは MIME から補完 (prototype: image.png)
      const sub = (mime.split('/')[1] ?? '').replace(/[^a-z0-9]/gi, '');
      name = mime.startsWith('image/') ? `image.${sub === '' ? 'png' : sub}` : `file.${sub === '' ? 'bin' : sub}`;
    }
    return name;
  }, []);

  /**
   * 1 ファイルを assets/ にアップロードする。名前衝突は連番リネーム
   * (image.png → image-1.png — AC-Sf53ad6-2-2)。失敗はエラートーストで通知し null。
   */
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
          if (known.has(candidate)) continue; // 既知の衝突は API を叩かず次候補へ
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
            if (err instanceof ApiError && err.status === 409) continue; // 衝突 → 連番リトライ
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

  /** D&D / ペーストのエントリポイント (Editor の uploadEnv から呼ばれる)。 */
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
        // 開いているノートがリンク書き換え対象なら最新をディスクから読み直す
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

  // ---- パンくず ----
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
      {/* ================= 左: サイドバー ================= */}
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
            if (journalBaseDate !== null) void openJournal(shiftJournalDate(journalBaseDate, -1));
          }}
          onNext={() => {
            if (journalBaseDate !== null) void openJournal(shiftJournalDate(journalBaseDate, 1));
          }}
          onToday={() => {
            setJournalListOpen(false);
            void openJournal();
          }}
          onToggleList={() => setJournalListOpen((v) => !v)}
          onSelectDate={(date) => {
            setJournalListOpen(false);
            void openJournal(date);
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
              onClick={() => setDialog({ type: 'new-folder' })}
            >
              <NewFolderIcon />
            </button>
          </span>
        </div>

        <FileTree
          nodes={tree}
          activePath={doc?.path ?? null}
          collapsed={collapsed}
          error={notesError}
          loaded={notes !== null}
          onToggleFolder={toggleFolder}
          onOpenNote={(path) => void openNotePath(path)}
          onOpenFile={(path) => void openFilePreview(path)}
          onContextMenu={onTreeContextMenu}
        />
      </aside>

      {/* ================= 中央: エディタ / ターミナル ================= */}
      <main className="workspace">
        {/* エディタ / ターミナルのタブ切替 (Sb7f458-2 — prototype/terminal.html) */}
        <div className="workspace-tabs" data-testid="workspace-tabs">
          <button
            className={`wtab${workspaceTab === 'editor' ? ' active' : ''}`}
            data-testid="tab-editor"
            aria-selected={workspaceTab === 'editor'}
            onClick={() => setWorkspaceTab('editor')}
          >
            <DocumentIcon />
            {breadcrumb?.name ?? 'エディタ'}
          </button>
          <button
            className={`wtab${workspaceTab === 'terminal' ? ' active' : ''}`}
            data-testid="tab-terminal"
            aria-selected={workspaceTab === 'terminal'}
            onClick={() => {
              setTerminalMounted(true);
              setWorkspaceTab('terminal');
            }}
          >
            <TerminalIcon />
            {terminalCmd !== null ? `ターミナル — ${terminalCmd}` : 'ターミナル'}
            {terminalMounted && (
              <span className={`live-dot${terminalStatus === 'connected' ? '' : ' off'}`} />
            )}
          </button>
        </div>

        <div
          className="workspace-editor"
          style={{ display: workspaceTab === 'editor' ? 'flex' : 'none' }}
        >
        <div className="editor-header">
          <div className="breadcrumb">
            {breadcrumb !== null ? (
              <>
                {breadcrumb.folders.map((f, i) => (
                  <span key={`${f}-${String(i)}`}>
                    <span>{f}</span>
                    <span className="sep"> / </span>
                  </span>
                ))}
                <span className="current">{breadcrumb.name}</span>
              </>
            ) : (
              <span className="current faint">ノートが開かれていません</span>
            )}
          </div>
          {appError !== null && (
            <div className="app-error" data-testid="app-error" title={appError}>
              {appError}
            </div>
          )}
          {doc !== null && preview === null && (
            <div className="save-status" data-testid="save-status" data-state={dirty ? 'dirty' : 'saved'}>
              <span className="dot" />
              <span>{dirty ? '未保存' : '保存済み'}</span>
            </div>
          )}
        </div>

        {preview !== null ? (
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
              <button className="btn primary" data-testid="empty-open-journal" onClick={() => void openJournal()}>
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
        {dragActive && preview === null && doc !== null && (
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
        </div>

        {/* ターミナル (一度開いたらタブ切替でも unmount しない — セッション維持) */}
        {terminalMounted && (
          <TerminalPane
            active={workspaceTab === 'terminal'}
            onStatusChange={setTerminalStatus}
            onCmdDetected={setTerminalCmd}
          />
        )}
      </main>

      {/* ================= 右: バックリンクパネル ================= */}
      <BacklinkPanel
        collapsed={panelCollapsed}
        onToggle={() => setPanelCollapsed((v) => !v)}
        notePath={doc?.path ?? null}
        refreshToken={backlinksToken}
        onOpenNote={(path) => void openNotePath(path)}
      />

      {/* ================= ポップアップ ================= */}
      {paletteOpen && (
        <SearchPalette
          onClose={() => setPaletteOpen(false)}
          onOpenNote={(path) => void openNotePath(path)}
          onOpenNoteAtLine={(path, line) => void openNoteAtLine(path, line)}
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
            setDialog({
              type: 'new-note',
              folder: menu.kind === 'folder' ? menu.path : dirnameOf(menu.path),
            });
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
          sub="フォルダは最初のノートを作成した時点でディスクに反映されます"
          initial=""
          placeholder="フォルダ名"
          confirmLabel="作成"
          testids={{ dialog: 'new-folder-dialog', input: 'new-folder-input', confirm: 'new-folder-confirm', cancel: 'new-folder-cancel' }}
          validate={(name) => {
            if (name === '') return 'フォルダ名を入力してください';
            if (name.startsWith('/') || name.endsWith('/')) return 'フォルダ名の先頭・末尾に / は使えません';
            return null;
          }}
          onConfirm={createFolder}
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
            if (name === current) return null; // 同名は no-op
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
            if (name === current) return null; // 同名は no-op
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
