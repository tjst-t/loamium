/**
 * スラッシュコマンドメニュー (Story S763a98-1 — prototype/slash-menu.html 準拠)。
 *
 * 行頭または空白の直後で `/` を入力するとコマンドメニューが開き、入力で絞り込み、
 * ↑↓/Enter・クリックで選択、Esc で閉じる。挿入結果はすべて標準 (ピュア) Markdown で、
 * カーソルは編集開始位置 (テーブルなら先頭セル等) に置かれる (priority 1: ピュア Markdown)。
 *
 * - 位置決めは CodeMirror の tooltip 基盤 (showTooltip) に載せ、既存の
 *   [[リンク]] オートコンプリート (wikilink.ts) と同じ仕組みに整合させる。
 * - コードフェンス内・インラインコード内では発火しない。判定は lezer-markdown の
 *   構文木 (live-preview.ts / outline.ts と同種) で行う (AC-S763a98-1-3)。
 * - 日本語 IME 対応: composition 中は開かず、キー操作も IME に委ねる。
 */
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { todayJournalDate } from '@loamium/shared';

// ---- コマンド定義 -----------------------------------------------------------

/** 挿入雛形。text を [/, cursor) 位置へ差し込み、caret を text 内 offset へ置く。 */
export interface SlashSnippet {
  /** 挿入する標準 Markdown 文字列 */
  text: string;
  /** 挿入後にカーソルを置く text 先頭からのオフセット (編集開始位置) */
  cursor: number;
}

export interface SlashCommand {
  /** data-command 値 (testid 契約) */
  command: string;
  /** 表示タイトル */
  title: string;
  /** 補足説明 */
  desc: string;
  /** 右肩のキーヒント表示 (/table 等) */
  kbd: string;
  /** 絞り込み用キーワード (latin/日本語)。command 自身も暗黙で対象 */
  keywords: string[];
  /** アイコン SVG (innerHTML) */
  icon: string;
  /** 挿入雛形を生成する (date のように動的なものがあるため関数) */
  build: () => SlashSnippet;
}

const ICON = {
  table:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.3"/><path d="M2 6.5h12M2 10h12M6.3 3v10"/></svg>',
  callout:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 6v3M8 11h.01"/></svg>',
  code: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5L3 8l3 3M10 5l3 3-3 3"/></svg>',
  mermaid:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="2" width="6" height="4" rx="1"/><rect x="1.5" y="10" width="5" height="4" rx="1"/><rect x="9.5" y="10" width="5" height="4" rx="1"/><path d="M8 6v2M8 8H4v2M8 8h4v2"/></svg>',
  dataview:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2z"/><path d="M2 4v8c0 1.1 2.7 2 6 2s6-.9 6-2V4"/><path d="M2 8c0 1.1 2.7 2 6 2s6-.9 6-2"/></svg>',
  checkbox:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="2.2"/><path d="M5 8l2.2 2.2L11 5.5"/></svg>',
  heading:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 3v10M12 3v10M4 8h8"/></svg>',
  date: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 2v2.5M11 2v2.5"/></svg>',
};

/** 挿入コマンド一覧 (prototype/slash-menu.html の並び順・data-command に一致)。 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    command: 'table',
    title: 'テーブル',
    desc: 'table · 表を挿入',
    kbd: '/table',
    keywords: ['table', 'テーブル', '表'],
    icon: ICON.table,
    // 標準 Markdown テーブル雛形。カーソルは先頭セル (編集開始位置)。
    build: () => ({
      text: '| 見出し1 | 見出し2 | 見出し3 |\n| --- | --- | --- |\n|  |  |  |',
      cursor: 2,
    }),
  },
  {
    command: 'callout',
    title: 'callout',
    desc: 'callout · [!note] 等の色付きボックス',
    kbd: '/callout',
    keywords: ['callout', 'note', 'ノート', '色付き'],
    icon: ICON.callout,
    // Obsidian 互換の callout。カーソルはタイトル位置。
    build: () => ({ text: '> [!note] タイトル\n> 本文', cursor: 10 }),
  },
  {
    command: 'code',
    title: 'コードフェンス',
    desc: 'code · ```lang でハイライト',
    kbd: '/code',
    keywords: ['code', 'コード', 'フェンス', 'fence'],
    icon: ICON.code,
    // ```lang\n\n``` の言語位置にカーソル。
    build: () => ({ text: '```\n\n```', cursor: 3 }),
  },
  {
    command: 'mermaid',
    title: 'mermaid',
    desc: 'mermaid · フローチャート/図',
    kbd: '/mermaid',
    keywords: ['mermaid', 'diagram', '図', 'フローチャート'],
    icon: ICON.mermaid,
    build: () => ({ text: '```mermaid\ngraph TD\n  A --> B\n```', cursor: 11 }),
  },
  {
    command: 'dataview',
    title: 'dataview',
    desc: 'dataview · LIST / TABLE / TASK クエリ',
    kbd: '/dataview',
    keywords: ['dataview', 'query', 'クエリ', 'list', 'table', 'task'],
    icon: ICON.dataview,
    build: () => ({ text: '```dataview\nLIST\n```', cursor: 12 }),
  },
  {
    command: 'checkbox',
    title: 'チェックボックス',
    desc: 'todo · - [ ] タスク行',
    kbd: '/todo',
    keywords: ['todo', 'task', 'checkbox', 'チェックボックス', 'タスク'],
    icon: ICON.checkbox,
    build: () => ({ text: '- [ ] ', cursor: 6 }),
  },
  {
    command: 'heading',
    title: '見出し',
    desc: 'heading · ## セクション見出し',
    kbd: '/h2',
    keywords: ['heading', 'h1', 'h2', 'h3', '見出し', 'section'],
    icon: ICON.heading,
    build: () => ({ text: '## ', cursor: 3 }),
  },
  {
    command: 'date',
    title: '日付',
    desc: 'date · 今日の日付',
    kbd: '/date',
    keywords: ['date', '日付', 'today', '今日'],
    icon: ICON.date,
    // 今日の日付 (YYYY-MM-DD)。カーソルは末尾。
    build: () => {
      const d = todayJournalDate();
      return { text: d, cursor: d.length };
    },
  },
];

// ---- 絞り込み ---------------------------------------------------------------

export interface FilteredCommand {
  command: SlashCommand;
  /** タイトル内の一致範囲 (mark ハイライト用)。null = タイトル一致なし */
  matchRange: [number, number] | null;
}

/** query (先頭の / は含まない) でコマンドを絞り込む。空クエリは全件。 */
export function filterSlashCommands(query: string): FilteredCommand[] {
  const q = query.trim().toLowerCase();
  const out: FilteredCommand[] = [];
  for (const command of SLASH_COMMANDS) {
    if (q.length === 0) {
      out.push({ command, matchRange: null });
      continue;
    }
    const titleIdx = command.title.toLowerCase().indexOf(q);
    const kwHit =
      command.command.toLowerCase().includes(q) ||
      command.keywords.some((k) => k.toLowerCase().includes(q));
    if (titleIdx >= 0) {
      out.push({ command, matchRange: [titleIdx, titleIdx + q.length] });
    } else if (kwHit) {
      out.push({ command, matchRange: null });
    }
  }
  return out;
}

// ---- 発火判定 (コード内抑制つき) --------------------------------------------

/** カーソル直前の `/query` トークンを検出。コード内・非空選択・非トリガー位置は null。 */
export function detectSlashTrigger(state: EditorState): { from: number; query: string } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null; // 範囲選択中は発火しない
  const pos = sel.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  // 行頭 or 空白直後の / + (空白と / を含まない語)
  const m = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  if (m === null) return null;
  const query = m[1] ?? '';
  const slashPos = pos - query.length - 1;

  // コードフェンス内・インラインコード内では発火しない (AC-S763a98-1-3)
  const tree = ensureSyntaxTree(state, pos, 100) ?? syntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(slashPos, 1);
  for (; node !== null; node = node.parent) {
    const n = node.name;
    if (
      n === 'FencedCode' ||
      n === 'CodeText' ||
      n === 'CodeBlock' ||
      n === 'InlineCode' ||
      n === 'CodeMark'
    ) {
      return null;
    }
  }
  return { from: slashPos, query };
}

// ---- 状態 (StateField + StateEffect) ----------------------------------------

interface SlashMenuState {
  /** メニュー表示中か */
  open: boolean;
  /** `/` の位置 (open 時のみ意味を持つ) */
  from: number;
  /** `/` の後ろの絞り込み文字列 */
  query: string;
  /** 選択中インデックス (絞り込み後リスト内) */
  selected: number;
  /** Esc で閉じた `/` 位置。同じ位置では再オープンしない (null = 抑制なし) */
  dismissedFrom: number | null;
}

const CLOSED: SlashMenuState = {
  open: false,
  from: 0,
  query: '',
  selected: 0,
  dismissedFrom: null,
};

/** 選択を上下に動かす (+1 / -1)。ラップアラウンド。 */
const moveSelection = StateEffect.define<number>();
/** メニューを明示的に閉じる (Esc)。 */
const dismissMenu = StateEffect.define<null>();

function wrap(index: number, len: number): number {
  if (len === 0) return 0;
  return ((index % len) + len) % len;
}

const slashMenuField = StateField.define<SlashMenuState>({
  create: (state) => deriveState(state, CLOSED, null),
  update(value, tr) {
    // dismissedFrom を編集に追従させる
    let dismissed = value.open ? null : value.dismissedFrom;
    if (tr.docChanged && dismissed !== null) dismissed = tr.changes.mapPos(dismissed);

    // Esc: 現在の from を抑制対象にして閉じる
    if (tr.effects.some((e) => e.is(dismissMenu))) {
      return { ...CLOSED, dismissedFrom: value.open ? value.from : dismissed };
    }

    // 選択移動 (open 中のみ意味を持つ。派生後に適用するため差分を集計)
    let move = 0;
    for (const e of tr.effects) if (e.is(moveSelection)) move += e.value;

    // IME 変換中の入力ではメニューを開かない (誤発火防止)。既存状態を維持。
    if (tr.isUserEvent('input.type.compose')) {
      return value.open ? value : { ...CLOSED, dismissedFrom: dismissed };
    }

    return deriveState(tr.state, value, dismissed, move);
  },
});

/**
 * open 中の tooltip を保持する。/ 位置 (from) が変わらない限り同一 Tooltip を保ち、
 * 絞り込み・選択移動は TooltipView.update で再描画する (毎打鍵の再生成を避ける)。
 */
const slashTooltipField = StateField.define<Tooltip | null>({
  create: (state) => computeTooltip(state, null),
  update: (value, tr) => computeTooltip(tr.state, value),
  provide: (f) => showTooltip.from(f),
});

function computeTooltip(state: EditorState, prev: Tooltip | null): Tooltip | null {
  const s = state.field(slashMenuField);
  if (!s.open) return null;
  if (prev !== null && prev.pos === s.from) return prev;
  return menuTooltip(s.from);
}

/** 現在のカーソル位置から次のメニュー状態を導出する。 */
function deriveState(
  state: EditorState,
  prev: SlashMenuState,
  dismissed: number | null,
  move = 0,
): SlashMenuState {
  const det = detectSlashTrigger(state);
  if (det === null) return { ...CLOSED, dismissedFrom: null };
  if (det.from === dismissed) return { ...CLOSED, dismissedFrom: dismissed };

  const items = filterSlashCommands(det.query);
  // 内容が同じ (from・query 不変) なら選択を保持、変わればリセット
  const keep = prev.open && prev.from === det.from && prev.query === det.query;
  const base = keep ? prev.selected : 0;
  const selected = wrap(base + move, items.length);
  return { open: true, from: det.from, query: det.query, selected, dismissedFrom: null };
}

// ---- 挿入 -------------------------------------------------------------------

/** 選択中コマンドを挿入する。/query を雛形で置換し、カーソルを編集開始位置へ。 */
function applyCommand(view: EditorView, s: SlashMenuState, cmd: SlashCommand): void {
  const snippet = cmd.build();
  const to = view.state.selection.main.head; // /query の直後 (= カーソル)
  view.dispatch({
    changes: { from: s.from, to, insert: snippet.text },
    selection: { anchor: s.from + snippet.cursor },
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  view.focus();
}

// ---- tooltip DOM ------------------------------------------------------------

/** open 中の tooltip を生成 (from が変わらない限り同一オブジェクトで update 再描画)。 */
function menuTooltip(from: number): Tooltip {
  return {
    pos: from,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view) => renderMenu(view),
  };
}

function renderMenu(view: EditorView): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'slash-menu';
  dom.setAttribute('data-testid', 'slash-menu');

  const head = document.createElement('div');
  head.className = 'slash-menu-head';
  const headLabel = document.createElement('span');
  headLabel.textContent = '挿入するブロック';
  const echo = document.createElement('span');
  echo.className = 'filter-echo';
  head.append(headLabel, echo);

  const list = document.createElement('div');
  list.className = 'slash-list';

  const empty = document.createElement('div');
  empty.className = 'slash-empty';
  empty.setAttribute('data-testid', 'slash-menu-empty');
  empty.textContent = '一致するコマンドがありません';

  const footer = document.createElement('div');
  footer.className = 'slash-footer';
  footer.innerHTML =
    '<span><kbd>↑</kbd><kbd>↓</kbd> 選択</span><span><kbd>Enter</kbd> 挿入</span><span><kbd>Esc</kbd> 閉じる</span>';

  dom.append(head, list, empty, footer);

  const render = (state: EditorState): void => {
    const s = state.field(slashMenuField);
    if (!s.open) return;
    echo.textContent = `/${s.query}`;
    const items = filterSlashCommands(s.query);
    empty.style.display = items.length === 0 ? 'block' : 'none';
    list.replaceChildren();
    items.forEach((fc, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = i === s.selected ? 'slash-item selected' : 'slash-item';
      btn.setAttribute('data-testid', 'slash-item');
      btn.setAttribute('data-command', fc.command.command);

      const ico = document.createElement('span');
      ico.className = 'slash-ico';
      ico.innerHTML = fc.command.icon;

      const main = document.createElement('span');
      main.className = 'slash-main';
      const title = document.createElement('span');
      title.className = 'slash-title';
      if (fc.matchRange !== null) {
        const [a, b] = fc.matchRange;
        title.append(document.createTextNode(fc.command.title.slice(0, a)));
        const mark = document.createElement('mark');
        mark.textContent = fc.command.title.slice(a, b);
        title.append(mark, document.createTextNode(fc.command.title.slice(b)));
      } else {
        title.textContent = fc.command.title;
      }
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      desc.textContent = fc.command.desc;
      main.append(title, desc);

      const kbd = document.createElement('span');
      kbd.className = 'slash-kbd';
      kbd.textContent = fc.command.kbd;

      btn.append(ico, main, kbd);
      // mousedown: エディタからフォーカス/カーソルを奪わずに挿入する
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyCommand(view, s, fc.command);
      });
      list.append(btn);
    });
  };

  render(view.state);

  return {
    dom,
    update: (update) => {
      if (update.state.field(slashMenuField).open) render(update.state);
    },
  };
}

// ---- キーマップ -------------------------------------------------------------

/** メニュー open 中だけ ↑↓/Enter/Esc を奪う。IME 変換中は委ねる。 */
const slashKeymap = keymap.of([
  {
    key: 'ArrowDown',
    run: (view) => {
      if (view.composing || !view.state.field(slashMenuField).open) return false;
      view.dispatch({ effects: moveSelection.of(1) });
      return true;
    },
  },
  {
    key: 'ArrowUp',
    run: (view) => {
      if (view.composing || !view.state.field(slashMenuField).open) return false;
      view.dispatch({ effects: moveSelection.of(-1) });
      return true;
    },
  },
  {
    key: 'Enter',
    run: (view) => {
      if (view.composing) return false;
      const s = view.state.field(slashMenuField);
      if (!s.open) return false;
      const items = filterSlashCommands(s.query);
      const chosen = items[s.selected];
      if (chosen === undefined) return false; // 一致 0 件: 通常の改行に委ねる
      applyCommand(view, s, chosen.command);
      return true;
    },
  },
  {
    key: 'Escape',
    run: (view) => {
      if (!view.state.field(slashMenuField).open) return false;
      view.dispatch({ effects: dismissMenu.of(null) });
      return true;
    },
  },
]);

/** スラッシュコマンドメニュー一式 (Editor に登録する)。 */
export function slashMenuExtension(): Extension {
  // オートコンプリート (Prec.highest の completionKeymap) より前で ↑↓/Enter/Esc を
  // 奪えるよう Prec.highest。Editor では wikilinkAutocomplete() より前に登録する
  // (同一 Prec 内は登録順で優先度が決まるため)。
  return [slashMenuField, slashTooltipField, Prec.highest(slashKeymap)];
}
