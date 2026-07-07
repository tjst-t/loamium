/**
 * スマートビュー (S8086d9-1)。
 *
 * サイドバーのスマートビューモードで描画されるコンポーネント。
 * GET /api/smart-folders で定義一式を取得し、pin / query の 2 種類を描画する。
 * - query フォルダ: collapsed 既定。展開時に GET /api/smart-folders/{id}/notes を呼ぶ。
 * - pin 葉: クリックでノートを開く。
 *
 * testid 契約 (gui-spec-S8086d9-1.json testid_contract 参照):
 *   smart-view, smart-view-loading, smart-view-error, smart-view-empty,
 *   smart-folder (data-id, aria-expanded), smart-folder-icon (data-icon),
 *   smart-folder-loading, smart-folder-error,
 *   smart-note (data-path), smart-pin (data-id, data-path)
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import type { NoteMeta, SmartViewItem } from '@loamium/shared';
import { api } from '../api.js';
import {
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  SearchIcon,
  WarnTriangleIcon,
} from '../icons.js';

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
}

function SmartFolder({ item, onOpenNote }: SmartFolderProps): JSX.Element {
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
      <button
        className="tree-item smart-folder-btn"
        onClick={toggle}
      >
        <ChevronDownIcon className={expanded ? 'chev' : 'chev closed'} />
        <SmartIcon icon={iconStr} />
        <span className="name">{item.name}</span>
      </button>
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
}

function SmartPin({ item, onOpenNote }: SmartPinProps): JSX.Element {
  const iconStr = item.icon ?? 'file-text';
  return (
    <button
      className="tree-item smart-pin-btn"
      data-testid="smart-pin"
      data-id={item.id}
      data-path={item.path}
      onClick={() => onOpenNote(item.path)}
      title={item.name ?? item.path}
    >
      <SmartIcon icon={iconStr} />
      <span className="name">{item.name ?? item.path}</span>
    </button>
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

export function SmartView({ onOpenNote, onSwitchToPhysical }: SmartViewProps): JSX.Element {
  const [viewState, setViewState] = useState<ViewLoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setViewState({ kind: 'loading' });
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
  }, []);

  if (viewState.kind === 'loading') {
    return (
      <div className="tree smart-view" data-testid="smart-view">
        <div className="smart-view-state" data-testid="smart-view-loading">
          読み込み中…
        </div>
      </div>
    );
  }

  if (viewState.kind === 'error') {
    return (
      <div className="tree smart-view" data-testid="smart-view">
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
      </div>
    );
  }

  const { items } = viewState;

  if (items.length === 0) {
    return (
      <div className="tree smart-view" data-testid="smart-view">
        <div className="smart-view-state" data-testid="smart-view-empty">
          <span>スマートフォルダがありません</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tree smart-view" data-testid="smart-view">
      {items.map((item) => {
        if (item.kind === 'query') {
          return <SmartFolder key={item.id} item={item} onOpenNote={onOpenNote} />;
        }
        return <SmartPin key={item.id} item={item} onOpenNote={onOpenNote} />;
      })}
    </div>
  );
}
