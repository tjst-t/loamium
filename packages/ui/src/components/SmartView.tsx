/**
 * スマートビュー (S8086d9-1 / S7b2f22-1)。
 *
 * サイドバーのスマートビューモードで描画されるコンポーネント。
 * GET /api/smart-folders で定義一式を取得し、pin / query の 2 種類を描画する。
 * - query フォルダ: collapsed 既定。展開時に GET /api/smart-folders/{id}/notes を呼ぶ。
 * - pin 葉: クリックでノートを開く。
 *
 * S7b2f22-1 追加 — 作成/編集/削除/並べ替え UI:
 *   GET /api/health でモードを確認し、full 時のみ作成/編集/削除/並べ替えを有効化する。
 *   変更は PUT /api/smart-folders で永続し、直後に再取得して表示に反映する。
 *
 * testid 契約 (gui-spec-S8086d9-1.json + S7b2f22-1 追加分):
 *   smart-view, smart-view-loading, smart-view-error, smart-view-empty,
 *   smart-folder (data-id, aria-expanded), smart-folder-icon (data-icon),
 *   smart-folder-loading, smart-folder-error,
 *   smart-note (data-path), smart-pin (data-id, data-path),
 *   smart-view-add,
 *   smart-folder-edit, smart-folder-delete, smart-folder-moveup, smart-folder-movedown
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import type { NoteMeta, PermissionMode, SmartViewItem } from '@loamium/shared';
import { api } from '../api.js';
import {
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
  WarnTriangleIcon,
} from '../icons.js';
import { SmartFolderForm } from './SmartFolderForm.js';

// --------------------------------------------------------------------------
// アイコンマップ (ビルトイン名 → JSX) — 未知の文字列は絵文字としてそのまま描画
// --------------------------------------------------------------------------

function BuiltinIconClock(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.5v3.5l2.5 2" />
    </svg>
  );
}

function BuiltinIconStar(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.7l4-.6z" />
    </svg>
  );
}

function BuiltinIconBookmark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h8v12l-4-2.5L4 14z" />
    </svg>
  );
}

function BuiltinIconHash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3.5 6h9M3.5 10h9M6.5 2l-1 12M10.5 2l-1 12" />
    </svg>
  );
}

function BuiltinIconCalendar(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M5.5 1.5v3M10.5 1.5v3M2 7h12" />
    </svg>
  );
}

function BuiltinIconCheckSquare(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5 8l2.5 2.5L11 6" />
    </svg>
  );
}

function BuiltinIconPin(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.5 2L14 5.5l-4 4-1.5 4-6-6 4-1.5z" />
      <path d="M6 10L2 14" />
    </svg>
  );
}

function BuiltinIconFlame(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14c-3.3 0-5-2-5-4.5C3 7 4.5 5.5 4.5 3.5 4.5 6 6 6.5 6 6.5c0-2 1.5-4 3.5-5-1 2 0 3.5 1.5 4C12 6.5 13 8 13 9.5c0 2.5-1.7 4.5-5 4.5z" />
    </svg>
  );
}

function BuiltinIconInbox(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9h3l1.5 2.5h3L11 9h3" />
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
    </svg>
  );
}

type BuiltinIconName =
  | 'clock' | 'star' | 'bookmark' | 'hash' | 'calendar'
  | 'check-square' | 'file-text' | 'folder' | 'search' | 'pin' | 'flame' | 'inbox';

const BUILTIN_ICONS: Record<BuiltinIconName, () => JSX.Element> = {
  clock: BuiltinIconClock,
  star: BuiltinIconStar,
  bookmark: BuiltinIconBookmark,
  hash: BuiltinIconHash,
  calendar: BuiltinIconCalendar,
  'check-square': BuiltinIconCheckSquare,
  'file-text': () => <FileIcon />,
  folder: () => <FolderIcon />,
  search: () => <SearchIcon />,
  pin: BuiltinIconPin,
  flame: BuiltinIconFlame,
  inbox: BuiltinIconInbox,
};

function isBuiltinName(s: string): s is BuiltinIconName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ICONS, s);
}

/** アイコン要素。data-icon に生の icon 文字列を持つ。 */
function SmartIcon({ icon }: { icon: string }): JSX.Element {
  if (isBuiltinName(icon)) {
    const Comp = BUILTIN_ICONS[icon];
    return (
      <span className="smart-icon svg-icon" data-testid="smart-folder-icon" data-icon={icon} aria-hidden="true">
        <Comp />
      </span>
    );
  }
  // 未知の名前 → 絵文字等そのまま
  return (
    <span className="smart-icon emoji-icon" data-testid="smart-folder-icon" data-icon={icon} aria-hidden="true">
      {icon}
    </span>
  );
}

// --------------------------------------------------------------------------
// アクションボタン共通
// --------------------------------------------------------------------------

interface ItemActions {
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

function ItemActionButtons({ actions }: { actions: ItemActions }): JSX.Element {
  return (
    <div className="smart-item-actions">
      <button
        className="smart-item-btn"
        data-testid="smart-folder-edit"
        title="編集"
        onClick={(e) => { e.stopPropagation(); actions.onEdit(); }}
      >
        <PencilIcon />
      </button>
      <button
        className="smart-item-btn"
        data-testid="smart-folder-moveup"
        title="上へ"
        disabled={!actions.canMoveUp}
        onClick={(e) => { e.stopPropagation(); actions.onMoveUp(); }}
      >
        ↑
      </button>
      <button
        className="smart-item-btn"
        data-testid="smart-folder-movedown"
        title="下へ"
        disabled={!actions.canMoveDown}
        onClick={(e) => { e.stopPropagation(); actions.onMoveDown(); }}
      >
        ↓
      </button>
      <button
        className="smart-item-btn danger"
        data-testid="smart-folder-delete"
        title="削除"
        onClick={(e) => { e.stopPropagation(); actions.onDelete(); }}
      >
        <TrashIcon />
      </button>
    </div>
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

interface SmartFolderProps {
  item: Extract<SmartViewItem, { kind: 'query' }>;
  onOpenNote: (path: string) => void;
  actions?: ItemActions;
}

function SmartFolder({ item, onOpenNote, actions }: SmartFolderProps): JSX.Element {
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

  return (
    <div
      className="smart-folder-wrap"
      data-testid="smart-folder"
      data-id={item.id}
      aria-expanded={expanded}
    >
      <div className="smart-folder-header">
        <button
          className="tree-item smart-folder-btn"
          onClick={toggle}
        >
          <ChevronDownIcon className={expanded ? 'chev' : 'chev closed'} />
          <SmartIcon icon={iconStr} />
          <span className="name">{item.name}</span>
        </button>
        {actions !== undefined && <ItemActionButtons actions={actions} />}
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
    </div>
  );
}

// --------------------------------------------------------------------------
// pin 葉
// --------------------------------------------------------------------------

interface SmartPinProps {
  item: Extract<SmartViewItem, { kind: 'pin' }>;
  onOpenNote: (path: string) => void;
  actions?: ItemActions;
}

function SmartPin({ item, onOpenNote, actions }: SmartPinProps): JSX.Element {
  const iconStr = item.icon ?? 'file-text';
  return (
    <div
      className="smart-pin-row"
      data-testid="smart-pin"
      data-id={item.id}
      data-path={item.path}
      onClick={() => onOpenNote(item.path)}
    >
      <button
        type="button"
        className="tree-item smart-pin-btn"
        onClick={(e) => { e.stopPropagation(); onOpenNote(item.path); }}
        title={item.name ?? item.path}
      >
        <SmartIcon icon={iconStr} />
        <span className="name">{item.name ?? item.path}</span>
      </button>
      {actions !== undefined && <ItemActionButtons actions={actions} />}
    </div>
  );
}

// --------------------------------------------------------------------------
// SmartView (ルートコンポーネント)
// --------------------------------------------------------------------------

export interface SmartViewProps {
  onOpenNote: (path: string) => void;
  onSwitchToPhysical: () => void;
}

type ViewLoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; items: SmartViewItem[] };

type FormMode =
  | null
  | { type: 'create' }
  | { type: 'edit'; item: SmartViewItem };

export function SmartView({ onOpenNote, onSwitchToPhysical }: SmartViewProps): JSX.Element {
  const [viewState, setViewState] = useState<ViewLoadState>({ kind: 'loading' });
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  // health チェック (モード確認) — マウント時 1 回
  useEffect(() => {
    let cancelled = false;
    api.getHealth().then(
      (res) => {
        if (!cancelled) setMode(res.mode);
      },
      () => {
        // health 取得失敗時はフルモードとして扱う (楽観的フォールバック)
        if (!cancelled) setMode('full');
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
          // 失敗時はコンソールに出力するのみ (ビュー状態は維持)
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

  // 削除
  const deleteItem = useCallback(
    (id: string): void => {
      if (viewState.kind !== 'loaded') return;
      handleMutation(viewState.items.filter((i) => i.id !== id));
    },
    [viewState, handleMutation],
  );

  // 並べ替え
  const moveItem = useCallback(
    (id: string, dir: 'up' | 'down'): void => {
      if (viewState.kind !== 'loaded') return;
      const idx = viewState.items.findIndex((i) => i.id === id);
      if (idx < 0) return;
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= viewState.items.length) return;
      const newItems = [...viewState.items];
      const itemA = newItems[idx];
      const itemB = newItems[swapIdx];
      if (itemA === undefined || itemB === undefined) return;
      newItems[idx] = itemB;
      newItems[swapIdx] = itemA;
      handleMutation(newItems);
    },
    [viewState, handleMutation],
  );

  // 編集時は自分の ID を除いた既存 ID セット
  const editingId = formMode?.type === 'edit' ? formMode.item.id : null;
  const existingIds = new Set(
    viewState.kind === 'loaded'
      ? viewState.items
          .filter((i) => editingId === null || i.id !== editingId)
          .map((i) => i.id)
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
              onSave={saveForm}
              onCancel={closeForm}
            />
          </div>
        </div>
      )}

      <div className="tree smart-view" data-testid="smart-view">
        {/* authoring ヘッダ — full モード時のみ */}
        {isFull && (
          <div className="smart-view-authoring-header">
            <button
              className="icon-btn smart-view-add-btn"
              data-testid="smart-view-add"
              title="スマートフォルダを追加"
              onClick={() => setFormMode({ type: 'create' })}
            >
              +
            </button>
          </div>
        )}

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
          viewState.items.map((item, idx) => {
            const actions: ItemActions | undefined = isFull
              ? {
                  onEdit: () => setFormMode({ type: 'edit', item }),
                  onDelete: () => deleteItem(item.id),
                  onMoveUp: () => moveItem(item.id, 'up'),
                  onMoveDown: () => moveItem(item.id, 'down'),
                  canMoveUp: idx > 0,
                  canMoveDown: idx < viewState.items.length - 1,
                }
              : undefined;

            if (item.kind === 'query') {
              return (
                <SmartFolder
                  key={item.id}
                  item={item}
                  onOpenNote={onOpenNote}
                  {...(actions !== undefined ? { actions } : {})}
                />
              );
            }
            return (
              <SmartPin
                key={item.id}
                item={item}
                onOpenNote={onOpenNote}
                {...(actions !== undefined ? { actions } : {})}
              />
            );
          })}
      </div>
    </>
  );
}
