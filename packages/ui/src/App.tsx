/**
 * Loamium UI ルート。3 ペイン (サイドバー / エディタ / バックリンクパネル)。
 *
 * - 起動時に GET /api/journal で今日のジャーナルを開く (DESIGN_PRINCIPLES ui_ux)。
 * - 保存は Cmd/Ctrl+S + デバウンス自動保存。PUT には baseMtime を添え、
 *   409 conflict は警告ダイアログ (上書き / 再読込) を出す (SPEC §9 高-1)。
 * - ファイルはピュア Markdown のまま (priority 1) — UI は content 文字列しか送らない。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react';
import { isValidJournalDate, shiftJournalDate, type NoteMeta } from '@loamium/shared';
import { api, ApiError } from './api.js';
import { buildTree } from './tree.js';
import { Editor } from './components/Editor.js';
import { FileTree } from './components/FileTree.js';
import { JournalNav } from './components/JournalNav.js';
import { BacklinkPanel } from './components/BacklinkPanel.js';
import { ContextMenu } from './components/ContextMenu.js';
import { ConflictDialog, DeleteDialog, NameDialog } from './components/dialogs.js';
import { DocumentIcon, GearIcon, NewFolderIcon, NewNoteIcon } from './icons.js';

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
  | null;

interface MenuState {
  x: number;
  y: number;
  path: string;
  isFolder: boolean;
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

export function App(): JSX.Element {
  // ---- サイドバー: ノート一覧とツリー ----
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

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
  }, []);

  const openNotePath = useCallback(
    async (path: string): Promise<void> => {
      if (docRef.current?.path === path) return;
      if (!(await saveNow())) return; // 競合/失敗中はノートを切り替えない
      try {
        const res = await api.getNote(path);
        setOpenDoc(res.path, res.content, res.mtime);
        setAppError(null);
      } catch (err) {
        setAppError(`ノートを開けませんでした — ${errMessage(err)}`);
      }
    },
    [saveNow, setOpenDoc],
  );

  const openJournal = useCallback(
    async (date?: string): Promise<void> => {
      if (!(await saveNow())) return;
      try {
        const res = await api.getJournal(date);
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
    void openJournal();
    // 起動時に一度だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- グローバルキー: Cmd/Ctrl+S (エディタ外フォーカス時) と F2 (リネーム) ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      } else if (e.key === 'F2' && docRef.current !== null) {
        e.preventDefault();
        setDialog({ type: 'rename', path: docRef.current.path });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNow]);

  // ---- ツリー操作 ----
  const tree = useMemo(() => buildTree(notes ?? [], extraFolders), [notes, extraFolders]);

  const toggleFolder = useCallback((path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onTreeContextMenu = useCallback((e: MouseEvent, path: string, isFolder: boolean): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path, isFolder });
  }, []);

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
        const res = await api.putNote(path, '');
        await refreshNotes();
        setOpenDoc(res.path, '', res.mtime);
        setAppError(null);
      } catch (err) {
        setAppError(`ノートを作成できませんでした — ${errMessage(err)}`);
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
        // 開いているノートのリネームは未保存編集を先に反映する
        if (docRef.current?.path === oldPath && !(await saveNow())) return;
        const current = await api.getNote(oldPath);
        const written = await api.putNote(newPath, current.content);
        await api.deleteNote(oldPath);
        await refreshNotes();
        if (docRef.current?.path === oldPath) {
          setOpenDoc(written.path, current.content, written.mtime);
        }
        setAppError(null);
      } catch (err) {
        setAppError(`リネームできませんでした — ${errMessage(err)}`);
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
    if (doc === null) return null;
    const segs = doc.path.split('/');
    const file = segs.at(-1) ?? doc.path;
    const name = file.endsWith('.md') ? file.slice(0, -3) : file;
    return { folders: segs.slice(0, -1), name };
  }, [doc]);

  return (
    <div className="app">
      {/* ================= 左: サイドバー ================= */}
      <aside className="sidebar" data-testid="sidebar">
        <div className="sidebar-header">
          <div className="vault-badge">L</div>
          <div className="vault-name">Loamium</div>
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
          onContextMenu={onTreeContextMenu}
        />
      </aside>

      {/* ================= 中央: エディタ ================= */}
      <main className="workspace">
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
          {doc !== null && (
            <div className="save-status" data-testid="save-status" data-state={dirty ? 'dirty' : 'saved'}>
              <span className="dot" />
              <span>{dirty ? '未保存' : '保存済み'}</span>
            </div>
          )}
        </div>

        {doc !== null ? (
          <Editor
            docPath={doc.path}
            content={doc.text}
            resetToken={doc.resetToken}
            onChange={onEditorChange}
            onSave={() => void saveNow()}
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
      </main>

      {/* ================= 右: バックリンクパネル ================= */}
      <BacklinkPanel collapsed={panelCollapsed} onToggle={() => setPanelCollapsed((v) => !v)} />

      {/* ================= ポップアップ ================= */}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          path={menu.path}
          isFolder={menu.isFolder}
          onOpen={() => {
            setMenu(null);
            void openNotePath(menu.path);
          }}
          onNewNote={() => {
            setMenu(null);
            setDialog({ type: 'new-note', folder: menu.isFolder ? menu.path : dirnameOf(menu.path) });
          }}
          onRename={() => {
            setMenu(null);
            setDialog({ type: 'rename', path: menu.path });
          }}
          onDelete={() => {
            setMenu(null);
            setDialog({ type: 'delete', path: menu.path });
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
          confirmLabel="リネーム"
          testids={{ dialog: 'rename-dialog', input: 'rename-input', confirm: 'rename-confirm', cancel: 'rename-cancel' }}
          validate={(name) => {
            const current = (dialog.path.split('/').at(-1) ?? '').replace(/\.md$/, '');
            if (name === current) return null; // 同名は no-op
            return validateNoteName(dirnameOf(dialog.path))(name);
          }}
          onConfirm={(name) => void renameNote(dialog.path, name)}
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

      {conflictPath !== null && (
        <ConflictDialog
          path={conflictPath}
          onOverwrite={resolveConflictOverwrite}
          onReload={() => void resolveConflictReload()}
        />
      )}
    </div>
  );
}
