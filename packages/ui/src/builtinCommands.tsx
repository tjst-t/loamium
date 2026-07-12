/**
 * 組み込みコマンドの静的定義 (Sde7a63-1 AC-Sde7a63-1-3)。
 *
 * 各コマンドの run は SearchPalette に渡されたコールバックを参照するため、
 * registerBuiltinCommands() を SearchPalette マウント時に呼ぶ設計にしている。
 * これにより App.tsx のハンドラ (setDialog / openSearch / openJournal 等) と
 * 正しく繋がる。
 *
 * コマンド ID は gui-spec-Sde7a63-1.json の testid_contract に一致させる。
 */
import React from 'react';
import { registerCommand } from './commandRegistry.js';

// --- アイコン (prototype/command-palette.html の inline SVG を React JSX で再現) ---

function NewNoteCommandIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 1.8h5.2L12.2 4.8v4.2M9.2 1.8v3h3M8 11v4M6 13h4" />
    </svg>
  );
}

function TemplateNoteIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2.6h8.4L13 4.2v9.2H3z" />
      <path d="M5 6h6M5 8.5h4" />
    </svg>
  );
}

function SmartFolderIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2 4.5h12v8.5H2zM2 4.5l2-2h3.5l1 1.5" />
      <path d="M7 8v3M5.5 9.5h3" />
    </svg>
  );
}

function AdvancedSearchIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4L14 14" />
      <path d="M5.5 7h3M7 5.5v3" />
    </svg>
  );
}

function JournalIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <rect x="2.4" y="3.3" width="11.2" height="10.3" rx="1.6" />
      <path d="M2.4 6.3h11.2M5.6 1.9v2.6M10.4 1.9v2.6" />
    </svg>
  );
}

/** コマンドが受け取るハンドラのインターフェイス。App.tsx のハンドラと 1:1 で対応。 */
export interface BuiltinCommandHandlers {
  /** 新規ノート作成ダイアログを開く */
  onNewNote: () => void;
  /** テンプレート選択ピッカーを開く */
  onOpenTemplatePicker: () => void;
  /** スマートフォルダ作成をトリガーする */
  onNewSmartFolder: () => void;
  /** 詳細検索ページへ遷移する */
  onOpenAdvancedSearch: () => void;
  /** 今日のジャーナルを開く */
  onOpenTodayJournal: () => void;
}

/**
 * 組み込みコマンド 5 件をレジストリに登録する。
 * SearchPalette の useEffect で handlers が揃ったタイミングで呼ぶ。
 * registerCommand は Map ベースの upsert (同 ID で上書き) なので、
 * clearRegistry() を呼ばずに再登録しても重複しない。
 * スマートコマンド (source='smart') は別 useEffect が登録するため、
 * ここでクリアすると消えてしまう — clearRegistry() は呼ばない。
 *
 * @param handlers App.tsx から注入されるコールバック群
 */
export function registerBuiltinCommands(handlers: BuiltinCommandHandlers): void {

  registerCommand({
    id: 'new-note',
    title: '新規ノート作成',
    keywords: ['new note', '新規', 'ノート', '作成', 'create'],
    icon: React.createElement(NewNoteCommandIcon),
    source: 'builtin',
    run: handlers.onNewNote,
  });

  registerCommand({
    id: 'new-note-from-template',
    title: 'テンプレートからノート作成',
    keywords: ['template', 'テンプレート', '新規', 'create from template'],
    icon: React.createElement(TemplateNoteIcon),
    source: 'builtin',
    run: handlers.onOpenTemplatePicker,
  });

  registerCommand({
    id: 'new-smart-folder',
    title: 'スマートフォルダ作成',
    keywords: ['smart folder', 'スマート', 'フォルダ', 'DQL', 'query'],
    icon: React.createElement(SmartFolderIcon),
    source: 'builtin',
    run: handlers.onNewSmartFolder,
  });

  registerCommand({
    id: 'open-advanced-search',
    title: '詳細検索を開く',
    keywords: ['search', '検索', 'advanced', '詳細', 'filter'],
    icon: React.createElement(AdvancedSearchIcon),
    source: 'builtin',
    run: handlers.onOpenAdvancedSearch,
  });

  registerCommand({
    id: 'open-today-journal',
    title: '今日のジャーナルを開く',
    keywords: ['journal', 'ジャーナル', 'today', '今日', 'diary'],
    icon: React.createElement(JournalIcon),
    source: 'builtin',
    run: handlers.onOpenTodayJournal,
  });
}
