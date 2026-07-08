/**
 * スマートフォルダ/ピン用アイコンセット (S7b2f22-2)。
 * SmartView.tsx と SmartFolderForm.tsx で共用するため独立モジュール化。
 */
import { type JSX } from 'react';
import { FileIcon, FolderIcon, SearchIcon } from '../icons.js';

// --------------------------------------------------------------------------
// ビルトインアイコン SVG
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

// --------------------------------------------------------------------------
// 型定義 + マッピング
// --------------------------------------------------------------------------

export type BuiltinIconName =
  | 'clock' | 'star' | 'bookmark' | 'hash' | 'calendar'
  | 'check-square' | 'file-text' | 'folder' | 'search' | 'pin' | 'flame' | 'inbox';

export const BUILTIN_ICON_NAMES: readonly BuiltinIconName[] = [
  'clock', 'star', 'bookmark', 'hash', 'calendar',
  'check-square', 'file-text', 'folder', 'search', 'pin', 'flame', 'inbox',
];

export const BUILTIN_ICONS: Record<BuiltinIconName, () => JSX.Element> = {
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

export function isBuiltinName(s: string): s is BuiltinIconName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ICONS, s);
}

/** アイコン要素。data-icon に生の icon 文字列を持つ。 */
export function SmartIcon({ icon }: { icon: string }): JSX.Element {
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
