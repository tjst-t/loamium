/**
 * スマートビュー (S8086d9-1 / S7b2f22-1 / S7b2f22-2 / Sebf6b0-2)。
 *
 * サイドバーのスマートビューモードで描画されるコンポーネント。
 * GET /api/smart-folders で定義一式を取得し、pin / query の 2 種類を描画する。
 * - query フォルダ: collapsed 既定。展開時に GET /api/smart-folders/{id}/notes を呼ぶ。
 * - pin 葉 (note-pin, path ends .md): クリックでノートを開く。
 * - pin フォルダ (folder-pin, path not ends .md): 展開可能行。展開時に
 *     GET /api/smart-folders/{id}/notes を呼ぶ。
 *
 * S7b2f22-1 追加 — 作成/編集/削除/並べ替え UI:
 *   GET /api/health でモードを確認し、full 時のみ authoring を有効化する。
 *   変更は PUT /api/smart-folders で永続し、直後に再取得して表示に反映する。
 *
 * S7b2f22-2 追加:
 *   - 右クリックコンテキストメニュー (smart-context-menu) で編集/削除
 *   - 削除確認ダイアログ (smart-delete-dialog)
 *   - HTML5 DnD 並べ替え (draggable 属性 + dragstart/dragover/drop)
 *   - +ボタンは App.tsx のヘッダ行へ移動 (triggerAdd prop で起動)
 *
 * Sebf6b0-2 追加:
 *   - folder-pin (pin.path not ending in .md) を展開可能行として描画。
 *   - note-pin (pin.path ending in .md) は従来どおり葉として描画。
 *
 * testid 契約:
 *   smart-view, smart-view-loading, smart-view-error, smart-view-empty,
 *   smart-folder (data-id, aria-expanded), smart-folder-icon (data-icon),
 *   smart-folder-loading, smart-folder-error,
 *   smart-note (data-path), smart-pin (data-id, data-path),
 *   smart-context-menu, smart-context-edit, smart-context-delete,
 *   smart-delete-dialog, smart-delete-confirm, smart-delete-cancel
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import type { NoteMeta, PermissionMode, SmartViewItem } from '@loamium/shared';
import { api } from '../api.js';
import {
  ChevronDownIcon,
  FileIcon,
  PencilIcon,
  TrashIcon,
  WarnTriangleIcon,
} from '../icons.js';
import { SmartIcon } from './SmartIcons.js';
import { SmartFolderForm } from './SmartFolderForm.js';

// --------------------------------------------------------------------------
// 削除確認ダイアログ
// --------------------------------------------------------------------------

function SmartDeleteDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        data-testid="smart-delete-dialog"
        aria-modal="true"
        aria-label="削除の確認"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>削除の確認</h2>
        <p className="dialog-sub">このスマートフォルダを削除しますか？</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn"
            data-testid="smart-delete-cancel"
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn danger"
            data-testid="smart-delete-confirm"
            onClick={onConfirm}
          >
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// 右クリックコンテキストメニュー
// --------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  item: SmartViewItem;
}

function SmartContextMenu({
  state,
  onEdit,
  onDelete,
  onClose,
}: {
  state: ContextMenuState;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // ビューポートはみ出し補正 (ContextMenu.tsx と同じパターン)
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el === null) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    el.style.left = `${String(Math.max(margin, Math.min(state.x, maxLeft)))}px`;
    el.style.top = `${String(Math.max(margin, Math.min(state.y, maxTop)))}px`;
  }, [state.x, state.y]);

  // Escape で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* 透明バックドロップ: メニュー外クリックで閉じる */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 49 }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="context-menu"
        data-testid="smart-context-menu"
        style={{ top: state.y, left: state.x }}
      >
        <button
          className="menu-item"
          data-testid="smart-context-edit"
          onClick={onEdit}
        >
          <PencilIcon />
          編集
        </button>
        <div className="menu-sep" />
        <button
          className="menu-item danger"
          data-testid="smart-context-delete"
          onClick={onDelete}
        >
          <TrashIcon />
          削除…
        </button>
      </div>
    </>
  );
}

// --------------------------------------------------------------------------
// query フォルダ内のノート行
// --------------------------------------------------------------------------

interface SmartNoteRowProps {
  note: NoteMeta;
  onOpenNote: (path: string) => void;
}

function SmartNoteRow({ note, onOpenNote }: SmartNoteRowProps): JSX.Element {
  return (
    <button
      className="tree-item smart-note-item"
      data-testid="smart-note"
      data-path={note.path}
      onClick={() => onOpenNote(note.path)}
      title={note.title ?? note.path}
    >
      <FileIcon className="file-ico" />
      <span className="name">{note.title ?? note.path}</span>
    </button>
  );
}

// --------------------------------------------------------------------------
// query フォルダ
// --------------------------------------------------------------------------

type FolderLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; notes: NoteMeta[] };

interface DragItemProps {
  draggable: boolean;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: (e: ReactDragEvent<HTMLElement>) => void;
  /** このアイテムが現在のドロップターゲットか */
  dropIndicator: 'before' | 'after' | null;
}

interface SmartFolderProps {
  item: Extract<SmartViewItem, { kind: 'query' }>;
  onOpenNote: (path: string) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>, item: SmartViewItem) => void;
  dragProps?: DragItemProps;
}

function SmartFolder({ item, onOpenNote, onContextMenu, dragProps }: SmartFolderProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<FolderLoadState>({ kind: 'idle' });

  const iconStr = item.icon ?? 'search';

  const toggle = useCallback((): void => {
    setExpanded((prev) => {
      const next = !prev;
      // 初めて展開するときのみ fetch
      if (next && loadState.kind === 'idle') {
        setLoadState({ kind: 'loading' });
        api.resolveSmartFolder(item.id).then(
          (res) => setLoadState({ kind: 'loaded', notes: res.notes }),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            setLoadState({ kind: 'error', message: msg });
          },
        );
      }
      return next;
    });
  }, [item.id, loadState.kind]);

  const dropIndicator = dragProps?.dropIndicator ?? null;

  return (
    <div
      className={`smart-folder-wrap${dragProps?.draggable === true ? ' smart-drag-item' : ''}${dropIndicator === 'before' ? ' smart-drop-before' : dropIndicator === 'after' ? ' smart-drop-after' : ''}`}
      data-testid="smart-folder"
      data-id={item.id}
      aria-expanded={expanded}
      draggable={dragProps?.draggable}
      onDragStart={dragProps?.onDragStart}
      onDragOver={dragProps?.onDragOver}
      onDrop={dragProps?.onDrop}
      onDragLeave={dragProps?.onDragLeave}
      onDragEnd={dragProps?.onDragEnd}
      onContextMenu={onContextMenu !== undefined ? (e) => onContextMenu(e, item) : undefined}
    >
      {dropIndicator === 'before' && <div className="smart-drop-indicator" data-testid="smart-drop-indicator" />}
      <div className="smart-folder-header">
        <button
          className="tree-item smart-folder-btn"
          onClick={toggle}
        >
          <ChevronDownIcon className={expanded ? 'chev' : 'chev closed'} />
          <SmartIcon icon={iconStr} />
          <span className="name">{item.name}</span>
        </button>
      </div>
      {expanded && (
        <div className="tree-children smart-folder-body">
          {loadState.kind === 'loading' && (
            <div className="smart-folder-state" data-testid="smart-folder-loading">
              読み込み中…
            </div>
          )}
          {loadState.kind === 'error' && (
            <div className="smart-folder-state smart-folder-state-error" data-testid="smart-folder-error">
              <WarnTriangleIcon />
              <span>取得に失敗しました</span>
            </div>
          )}
          {loadState.kind === 'loaded' &&
            loadState.notes.map((note) => (
              <SmartNoteRow key={note.path} note={note} onOpenNote={onOpenNote} />
            ))}
        </div>
      )}
      {dropIndicator === 'after' && <div className="smart-drop-indicator" data-testid="smart-drop-indicator" />}
    </div>
  );
}

// --------------------------------------------------------------------------
// pin 葉
// --------------------------------------------------------------------------

interface SmartPinProps {
  item: Extract<SmartViewItem, { kind: 'pin' }>;
  onOpenNote: (path: string) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>, item: SmartViewItem) => void;
  dragProps?: DragItemProps;
}

function SmartPin({ item, onOpenNote, onContextMenu, dragProps }: SmartPinProps): JSX.Element {
  const iconStr = item.icon ?? 'file-text';
  const dropIndicator = dragProps?.dropIndicator ?? null;
  return (
    <div
      className={`smart-pin-row${dragProps?.draggable === true ? ' smart-drag-item' : ''}${dropIndicator === 'before' ? ' smart-drop-before' : dropIndicator === 'after' ? ' smart-drop-after' : ''}`}
      data-testid="smart-pin"
      data-id={item.id}
      data-path={item.path}
      draggable={dragProps?.draggable}
      onDragStart={dragProps?.onDragStart}
      onDragOver={dragProps?.onDragOver}
      onDrop={dragProps?.onDrop}
      onDragLeave={dragProps?.onDragLeave}
      onDragEnd={dragProps?.onDragEnd}
      onContextMenu={onContextMenu !== undefined ? (e) => onContextMenu(e, item) : undefined}
      onClick={() => onOpenNote(item.path)}
    >
      {dropIndicator === 'before' && <div className="smart-drop-indicator" data-testid="smart-drop-indicator" />}
      <button
        type="button"
        className="tree-item smart-pin-btn"
        onClick={(e) => { e.stopPropagation(); onOpenNote(item.path); }}
        title={item.name ?? item.path}
      >
        <SmartIcon icon={iconStr} />
        <span className="name">{item.name ?? item.path}</span>
      </button>
      {dropIndicator === 'after' && <div className="smart-drop-indicator" data-testid="smart-drop-indicator" />}
    </div>
  );
}

// --------------------------------------------------------------------------
// folder-pin (Sebf6b0-2 AC-2-3): pin.path が .md 以外 → 展開可能フォルダ行
// --------------------------------------------------------------------------

interface SmartFolderPinProps {
  item: Extract<SmartViewItem, { kind: 'pin' }>;
  onOpenNote: (path: string) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>, item: SmartViewItem) => void;
  dragProps?: DragItemProps;
}

function SmartFolderPin({
  item,
  onOpenNote,
  onContextMenu,
  dragProps,
}: SmartFolderPinProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<FolderLoadState>({ kind: 'idle' });

  const iconStr = item.icon ?? 'folder';

  const toggle = useCallback((): void => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && loadState.kind === 'idle') {
        setLoadState({ kind: 'loading' });
        api.resolveSmartFolder(item.id).then(
          (res) => setLoadState({ kind: 'loaded', notes: res.notes }),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            setLoadState({ kind: 'error', message: msg });
          },
        );
      }
      return next;
    });
  }, [item.id, loadState.kind]);

  const dropIndicator = dragProps?.dropIndicator ?? null;

  return (
    <div
      className={`smart-folder-wrap${dragProps?.draggable === true ? ' smart-drag-item' : ''}${dropIndicator === 'before' ? ' smart-drop-before' : dropIndicator === 'after' ? ' smart-drop-after' : ''}`}
      data-testid="smart-pin"
      data-id={item.id}
      data-path={item.path}
      aria-expanded={expanded}
      draggable={dragProps?.draggable}
      onDragStart={dragProps?.onDragStart}
      onDragOver={dragProps?.onDragOver}
      onDrop={dragProps?.onDrop}
      onDragLeave={dragProps?.onDragLeave}
      onDragEnd={dragProps?.onDragEnd}
      onContextMenu={onContextMenu !== undefined ? (e) => onContextMenu(e, item) : undefined}
    >
      {dropIndicator === 'before' && <div className="smart-drop-indicator" data-testid="smart-drop-indicator" />}
      <div className="smart-folder-header">
        <button
          type="button"
          className="tree-item smart-folder-btn"
          onClick={toggle}
          title={item.name ?? item.path}
        >
          <ChevronDownIcon className={expanded ? 'chev' : 'chev closed'} />
          <SmartIcon icon={iconStr} />
          <span className="name">{item.name ?? item.path}</span>
        </button>
      </div>
      {expanded && (
        <div className="tree-children smart-folder-body">
          {loadState.kind === 'loading' && (
            <div className="smart-folder-state" data-testid="smart-folder-loading">
              読み込み中…
            </div>
          )}
          {loadState.kind === 'error' && (
            <div className="smart-folder-state smart-folder-state-error" data-testid="smart-folder-error">
              <WarnTriangleIcon />
              <span>取得に失敗しました</span>
            </div>
          )}
          {loadState.kind === 'loaded' &&
            loadState.notes.map((note) => (
              <SmartNoteRow key={note.path} note={note} onOpenNote={onOpenNote} />
            ))}
        </div>
      )}
      {dropIndicator === 'after' && <div className="smart-drop-indicator" data-testid="smart-drop-indicator" />}
    </div>
  );
}

// --------------------------------------------------------------------------
// SmartView (ルートコンポーネント)
// --------------------------------------------------------------------------

export interface SmartViewProps {
  onOpenNote: (path: string) => void;
  onSwitchToPhysical: () => void;
  /** インクリメントで作成フォームを開く (App.tsx の + ボタンから) */
  triggerAdd?: number;
  /** モード確定時に通知 (App.tsx がヘッダの + ボタン表示判定に使う) */
  onModeChange?: (mode: PermissionMode | null) => void;
}

type ViewLoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; items: SmartViewItem[] };

type FormMode =
  | null
  | { type: 'create' }
  | { type: 'edit'; item: SmartViewItem };

export function SmartView({ onOpenNote, onSwitchToPhysical, triggerAdd, onModeChange }: SmartViewProps): JSX.Element {
  const [viewState, setViewState] = useState<ViewLoadState>({ kind: 'loading' });
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // DnD 用
  const dragSrcIdRef = useRef<string | null>(null);
  /** ドロップ挿入位置インジケーター: id=null は非表示 */
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);

  // onModeChange は描画ごとに新しい参照になる可能性があるため ref で保持
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  // health チェック (モード確認) — マウント時 1 回
  useEffect(() => {
    let cancelled = false;
    api.getHealth().then(
      (res) => {
        if (!cancelled) {
          setMode(res.mode);
          onModeChangeRef.current?.(res.mode);
        }
      },
      () => {
        // health 取得失敗時はフルモードとして扱う (楽観的フォールバック)
        if (!cancelled) {
          setMode('full');
          onModeChangeRef.current?.('full');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // スマートフォルダ一覧取得 + refresh
  useEffect(() => {
    let cancelled = false;
    api.listSmartFolders().then(
      (cfg) => {
        if (!cancelled) setViewState({ kind: 'loaded', items: cfg.items });
      },
      (err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setViewState({ kind: 'error', message });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshCount]);

  const refresh = useCallback((): void => {
    setRefreshCount((c) => c + 1);
  }, []);

  const closeForm = useCallback((): void => {
    setFormMode(null);
  }, []);

  // アイテムリストの変更を PUT して再取得
  const handleMutation = useCallback(
    (newItems: SmartViewItem[]): void => {
      void api.putSmartFolders({ version: 1, items: newItems }).then(
        () => {
          setFormMode(null);
          refresh();
        },
        (err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('putSmartFolders failed', err);
        },
      );
    },
    [refresh],
  );

  // フォームから保存 (新規 or 編集)
  const saveForm = useCallback(
    (newItem: SmartViewItem): void => {
      if (viewState.kind !== 'loaded') return;
      const existingIdx = viewState.items.findIndex((i) => i.id === newItem.id);
      const newItems =
        existingIdx >= 0
          ? viewState.items.map((i) => (i.id === newItem.id ? newItem : i))
          : [...viewState.items, newItem];
      handleMutation(newItems);
    },
    [viewState, handleMutation],
  );

  // 削除 (deleteTargetId 確定後に呼ばれる)
  const deleteItem = useCallback(
    (id: string): void => {
      if (viewState.kind !== 'loaded') return;
      handleMutation(viewState.items.filter((i) => i.id !== id));
    },
    [viewState, handleMutation],
  );

  // App.tsx の + ボタン → triggerAdd インクリメントでフォームを開く
  const prevTriggerRef = useRef(0);
  useEffect(() => {
    if (triggerAdd === undefined || triggerAdd <= 0) return;
    if (triggerAdd === prevTriggerRef.current) return;
    prevTriggerRef.current = triggerAdd;
    if (mode === 'full') {
      setFormMode({ type: 'create' });
    }
  }, [triggerAdd, mode]);

  // ---- DnD ハンドラ ----
  const handleDragStart = useCallback(
    (id: string) =>
      (e: ReactDragEvent<HTMLElement>): void => {
        dragSrcIdRef.current = id;
        e.dataTransfer.effectAllowed = 'move';
      },
    [],
  );

  const handleDragOver = useCallback(
    (id: string) =>
      (e: ReactDragEvent<HTMLElement>): void => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // ドロップ挿入位置を計算して indicator を更新する
        const el = e.currentTarget as HTMLElement;
        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
        setDropTarget((prev) =>
          prev?.id === id && prev.position === position ? prev : { id, position },
        );
      },
    [],
  );

  const clearDropTarget = useCallback((): void => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    (targetId: string) =>
      (e: ReactDragEvent<HTMLElement>): void => {
        e.preventDefault();
        setDropTarget(null);
        const srcId = dragSrcIdRef.current;
        dragSrcIdRef.current = null;
        if (srcId === null || srcId === targetId) return;
        if (viewState.kind !== 'loaded') return;
        const items = [...viewState.items];
        const srcIdx = items.findIndex((i) => i.id === srcId);
        const tgtIdx = items.findIndex((i) => i.id === targetId);
        if (srcIdx < 0 || tgtIdx < 0) return;
        const moved = items.splice(srcIdx, 1)[0];
        if (moved === undefined) return;
        items.splice(tgtIdx, 0, moved);
        handleMutation(items);
      },
    [viewState, handleMutation],
  );

  // ---- コンテキストメニュー ----
  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>, item: SmartViewItem): void => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, item });
    },
    [],
  );

  const closeContextMenu = useCallback((): void => {
    setContextMenu(null);
  }, []);

  const handleContextEdit = useCallback((): void => {
    if (contextMenu === null) return;
    setFormMode({ type: 'edit', item: contextMenu.item });
    setContextMenu(null);
  }, [contextMenu]);

  const handleContextDelete = useCallback((): void => {
    if (contextMenu === null) return;
    setDeleteTargetId(contextMenu.item.id);
    setContextMenu(null);
  }, [contextMenu]);

  // 編集時は自分の ID を除いた既存 ID セット
  const editingId = formMode?.type === 'edit' ? formMode.item.id : null;
  const existingIds = new Set(
    viewState.kind === 'loaded'
      ? viewState.items
          .filter((i) => editingId === null || i.id !== editingId)
          .map((i) => i.id)
      : [],
  );
  // 名前重複チェック用 (自分の名前は除外)
  const existingNames = new Set(
    viewState.kind === 'loaded'
      ? viewState.items
          .filter((i) => editingId === null || i.id !== editingId)
          .map((i) => (i.name ?? '').trim())
          .filter((n) => n !== '')
      : [],
  );

  const isFull = mode === 'full';

  return (
    <>
      {/* 作成/編集フォーム (ダイアログ) */}
      {formMode !== null && (
        <div className="dialog-backdrop" onClick={closeForm}>
          <div
            className="dialog sf-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              formMode.type === 'create'
                ? 'スマートフォルダを追加'
                : 'スマートフォルダを編集'
            }
            onClick={(e) => e.stopPropagation()}
          >
            <h2>
              {formMode.type === 'create'
                ? 'スマートフォルダを追加'
                : 'スマートフォルダを編集'}
            </h2>
            <SmartFolderForm
              {...(formMode.type === 'edit' ? { initial: formMode.item } : {})}
              existingIds={existingIds}
              existingNames={existingNames}
              onSave={saveForm}
              onCancel={closeForm}
            />
          </div>
        </div>
      )}

      {/* 削除確認ダイアログ */}
      {deleteTargetId !== null && (
        <SmartDeleteDialog
          onConfirm={() => {
            const id = deleteTargetId;
            setDeleteTargetId(null);
            deleteItem(id);
          }}
          onCancel={() => setDeleteTargetId(null)}
        />
      )}

      {/* 右クリックコンテキストメニュー (full モード時のみ) */}
      {contextMenu !== null && isFull && (
        <SmartContextMenu
          state={contextMenu}
          onEdit={handleContextEdit}
          onDelete={handleContextDelete}
          onClose={closeContextMenu}
        />
      )}

      <div className="tree smart-view" data-testid="smart-view">
        {/* ローディング */}
        {viewState.kind === 'loading' && (
          <div className="smart-view-state" data-testid="smart-view-loading">
            読み込み中…
          </div>
        )}

        {/* エラー */}
        {viewState.kind === 'error' && (
          <div className="smart-view-state smart-view-state-error" data-testid="smart-view-error">
            <WarnTriangleIcon />
            <span>スマートフォルダの読み込みに失敗しました</span>
            <button
              className="smart-view-retry"
              onClick={onSwitchToPhysical}
            >
              物理ビューへ戻る
            </button>
          </div>
        )}

        {/* 空状態 */}
        {viewState.kind === 'loaded' && viewState.items.length === 0 && (
          <div className="smart-view-state" data-testid="smart-view-empty">
            <span>スマートフォルダがありません</span>
          </div>
        )}

        {/* アイテム一覧 */}
        {viewState.kind === 'loaded' &&
          viewState.items.map((item) => {
            const dragProps: DragItemProps | undefined = isFull
              ? {
                  draggable: true,
                  onDragStart: handleDragStart(item.id),
                  onDragOver: handleDragOver(item.id),
                  onDrop: handleDrop(item.id),
                  onDragLeave: clearDropTarget,
                  onDragEnd: clearDropTarget,
                  dropIndicator: dropTarget?.id === item.id ? (dropTarget.position) : null,
                }
              : undefined;

            if (item.kind === 'query') {
              return (
                <SmartFolder
                  key={item.id}
                  item={item}
                  onOpenNote={onOpenNote}
                  {...(isFull ? { onContextMenu: handleContextMenu } : {})}
                  {...(dragProps !== undefined ? { dragProps } : {})}
                />
              );
            }
            // Sebf6b0-2 AC-2-3: folder-pin (path not ending .md) → expandable
            if (!item.path.endsWith('.md')) {
              return (
                <SmartFolderPin
                  key={item.id}
                  item={item}
                  onOpenNote={onOpenNote}
                  {...(isFull ? { onContextMenu: handleContextMenu } : {})}
                  {...(dragProps !== undefined ? { dragProps } : {})}
                />
              );
            }
            // note-pin (path ends .md) → clickable leaf
            return (
              <SmartPin
                key={item.id}
                item={item}
                onOpenNote={onOpenNote}
                {...(isFull ? { onContextMenu: handleContextMenu } : {})}
                {...(dragProps !== undefined ? { dragProps } : {})}
              />
            );
          })}
      </div>
    </>
  );
}
