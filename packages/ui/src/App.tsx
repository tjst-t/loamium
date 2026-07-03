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
import { DocumentIcon, GearIcon, LinkIcon, NewFolderIcon, NewNoteIcon } from './icons.js';

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
  /** 保存成功のたびに増える — バックリンクパネルの再取得トリガー (S6fbf45-2) */
  const [backlinksToken, setBacklinksToken] = useState(0);

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
  const modalOpenRef = useRef(false);
  modalOpenRef.current = dialog !== null || conflictPath !== null || menu !== null;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      } else if (e.key === 'F2' && docRef.current !== null && !modalOpenRef.current) {
        // ダイアログ・メニュー表示中は F2 で状態を奪わない
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
            notes={notes}
            onChange={onEditorChange}
            onSave={() => void saveNow()}
            onOpenNote={(path) => void openNotePath(path)}
            onCreateAndOpenNote={(target) => void createNoteFromLink(target, true)}
            onCreateNote={(target) => void createNoteFromLink(target, false)}
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
      <BacklinkPanel
        collapsed={panelCollapsed}
        onToggle={() => setPanelCollapsed((v) => !v)}
        notePath={doc?.path ?? null}
        refreshToken={backlinksToken}
        onOpenNote={(path) => void openNotePath(path)}
      />

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
