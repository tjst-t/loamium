/**
 * リスト行限定のアウトライン操作 (C 方式 — Story S9ab6c3-1)。
 *
 * - Tab / Shift+Tab: カーソルがリスト行 (- / 1. / - [ ]) にあるときだけ
 *   サブツリーごとインデント / アンインデントする。見出し・段落では発火せず
 *   ブラウザ既定に委ねる (DESIGN_PRINCIPLES ui_ux: リスト行のみ)。
 * - 折りたたみ: 子行を持つリスト行のガターに fold-toggle を表示し、
 *   サブツリー (ListItem ノードの残り行) を折りたたむ。placeholder は
 *   fold-pill (「… N 行」)。
 * - チェックボックス: - [ ] / - [x] を ListItem のマーカー直後から直接検出し、
 *   クリック可能なウィジェットに置換する (カーソル行はソース表示)。トグルは
 *   ドキュメント編集なので、既存の自動保存フローでピュア Markdown としてファイル
 *   に載る。空タスク `- [ ]` も取りこぼさない。
 * - 箇条書きドット: - / * / + のマーカーを深さ別の装飾ドット (• / ◦ / ▪) に
 *   置換する (カーソル行はソース表示)。数字リストは素のまま。
 *
 * リスト行判定は lezer-markdown の構文木 (ListItem) で行う (decisions.json I2)。
 */
import { EditorState, Prec, type Extension, type Line } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  extractInlineFields,
  setInlineField,
  DEFAULT_TASK_VOCAB,
  type TaskVocabRequired,
} from '@loamium/shared';
import { api } from './api.js';
import { notePathFacet } from './live-preview.js';

/** インデント単位 (4 スペース — decisions.json I1: 1. リストの CommonMark ネスト要件を満たす) */
export const INDENT_UNIT = '    ';

/** 選択範囲が触れている行番号の集合 (ソース表示すべき「カーソル行」) */
export function activeLines(state: EditorState): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

/** この行から始まる ListItem ノード (無ければ null = リスト行ではない) */
export function listItemStartingAt(state: EditorState, line: Line): SyntaxNode | null {
  const firstChar = line.text.search(/\S/);
  if (firstChar < 0) return null;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + firstChar, 1);
  for (; node !== null; node = node.parent) {
    if (node.name === 'ListItem' && state.doc.lineAt(node.from).number === line.number) {
      return node;
    }
  }
  return null;
}

/** ListItem サブツリーの最終行番号 (継続行・ネストした子リストを含む) */
function subtreeEndLine(state: EditorState, item: SyntaxNode, startLine: number): number {
  const endLine = state.doc.lineAt(item.to);
  // ノード終端がちょうど行頭にある場合はその前の行までがサブツリー
  if (endLine.from === item.to && endLine.number > startLine) return endLine.number - 1;
  return endLine.number;
}

/**
 * リスト行のインデント操作。リスト行でなければ false (キーを消費しない)。
 * dir=1: サブツリー全行に INDENT_UNIT を挿入 / dir=-1: 先頭行の字下げ幅を上限に削る。
 */
function changeListIndent(view: EditorView, dir: 1 | -1): boolean {
  if (view.composing) return false; // IME 変換中は Tab を奪わない (decisions.json I3)
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const item = listItemStartingAt(state, line);
  if (item === null) return false;

  const start = line.number;
  const end = subtreeEndLine(state, item, start);
  const changes: { from: number; to?: number; insert?: string }[] = [];

  if (dir === 1) {
    // アウトライナー標準: 直前に同レベルの兄弟項目があるときだけ 1 段深くできる。
    // 先頭項目を字下げすると CommonMark ではコードブロック化し
    // ピュア Markdown を壊すため no-op とする (priority 1)。
    let prev = item.prevSibling;
    while (prev !== null && prev.name !== 'ListItem') prev = prev.prevSibling;
    if (prev === null) return true; // リスト行として消費するが no-op
    for (let n = start; n <= end; n++) {
      const l = state.doc.line(n);
      if (l.length === 0) continue; // 空行はインデントしない
      changes.push({ from: l.from, insert: INDENT_UNIT });
    }
  } else {
    const leading = /^ */.exec(line.text)?.[0].length ?? 0;
    const removable = Math.min(INDENT_UNIT.length, leading);
    if (removable === 0) return true; // トップレベルでの Shift+Tab は no-op (リスト行として消費)
    for (let n = start; n <= end; n++) {
      const l = state.doc.line(n);
      const lead = /^ */.exec(l.text)?.[0].length ?? 0;
      if (lead === 0) continue;
      changes.push({ from: l.from, to: l.from + Math.min(removable, lead) });
    }
  }

  if (changes.length === 0) return true;
  view.dispatch({
    changes,
    scrollIntoView: true,
    userEvent: dir === 1 ? 'input.indent' : 'delete.dedent',
  });
  return true;
}

const outlineKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Tab', run: (view) => changeListIndent(view, 1) },
    { key: 'Shift-Tab', run: (view) => changeListIndent(view, -1) },
  ]),
);

// ---- 折りたたみ (fold-toggle ガター + fold-pill placeholder) ----------------

/** リスト行の折りたたみ対象範囲 (行末〜サブツリー末尾)。子行が無ければ null */
function foldableListRange(state: EditorState, line: Line): { from: number; to: number } | null {
  const item = listItemStartingAt(state, line);
  if (item === null) return null;
  const end = subtreeEndLine(state, item, line.number);
  if (end <= line.number) return null;
  return { from: line.to, to: state.doc.line(end).to };
}

/** 行末から始まる折りたたみ済み範囲 */
function foldedAt(state: EditorState, line: Line): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => {
    if (from === line.to) {
      found = { from, to };
      return false;
    }
    return undefined;
  });
  return found;
}

const CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const CHEVRON_RIGHT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';

class FoldToggleMarker extends GutterMarker {
  constructor(
    readonly lineNo: number,
    readonly folded: boolean,
  ) {
    super();
  }

  override eq(other: FoldToggleMarker): boolean {
    return other.lineNo === this.lineNo && other.folded === this.folded;
  }

  override toDOM(): Node {
    const btn = document.createElement('button');
    btn.className = this.folded ? 'fold-toggle folded' : 'fold-toggle';
    btn.setAttribute('data-testid', 'fold-toggle');
    btn.setAttribute('data-line', String(this.lineNo));
    if (this.folded) btn.setAttribute('data-folded', 'true');
    btn.title = this.folded ? 'サブツリーを展開する' : 'サブツリーを折りたたむ';
    btn.innerHTML = this.folded ? CHEVRON_RIGHT : CHEVRON_DOWN;
    return btn;
  }
}

function isFoldTransaction(update: ViewUpdate): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
  );
}

const outlineFoldGutter: Extension = gutter({
  class: 'cm-outline-gutter',
  lineMarker(view, block) {
    const line = view.state.doc.lineAt(block.from);
    if (foldableListRange(view.state, line) === null) return null;
    return new FoldToggleMarker(line.number, foldedAt(view.state, line) !== null);
  },
  lineMarkerChange: (update) =>
    update.docChanged || update.viewportChanged || isFoldTransaction(update),
  domEventHandlers: {
    click(view, block) {
      const line = view.state.doc.lineAt(block.from);
      const folded = foldedAt(view.state, line);
      if (folded !== null) {
        view.dispatch({ effects: unfoldEffect.of(folded) });
        return true;
      }
      const range = foldableListRange(view.state, line);
      if (range === null) return false;
      view.dispatch({ effects: foldEffect.of(range) });
      return true;
    },
  },
});

const outlineFolding: Extension = codeFolding({
  preparePlaceholder(state, range) {
    return state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number;
  },
  placeholderDOM(view, onclick, prepared) {
    const span = document.createElement('span');
    span.className = 'fold-pill';
    span.setAttribute('data-testid', 'fold-pill');
    const lines = typeof prepared === 'number' ? prepared : 0;
    span.textContent = `… ${String(lines)} 行`;
    span.title = `折りたたまれた ${String(lines)} 行を展開`;
    span.setAttribute('aria-label', span.title);
    span.onclick = onclick;
    return span;
  },
});

// ---- チェックボックス (- [ ] / - [x]) + ピル + トリガー --------------------

const CHECK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>';
const GEAR_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>';
const FLAG_OUTLINE_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h10l-2 4 2 4H5v4H3z"/></svg>';
const CAL_SMALL_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2.5" y="3" width="11" height="10.5" rx="2"/><path d="M2.5 7h11M5.5 1v3M10.5 1v3"/></svg>';
const CHECK_MARK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4 4 6-7"/></svg>';

/** キャッシュ: 語彙を一度取得したら再利用 */
let _cachedVocab: TaskVocabRequired | null = null;

async function getVocab(): Promise<TaskVocabRequired> {
  if (_cachedVocab !== null) return _cachedVocab;
  try {
    _cachedVocab = await api.getTaskVocab();
  } catch {
    _cachedVocab = DEFAULT_TASK_VOCAB;
  }
  return _cachedVocab;
}

/** 今日の YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 明日の YYYY-MM-DD */
function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 来週月曜の YYYY-MM-DD */
function nextWeekStr(): string {
  const d = new Date();
  const day = d.getDay();
  const daysToMon = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysToMon);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 期日クラス */
function dueCssClass(due: string): string {
  const today = todayStr();
  const tom = tomorrowStr();
  if (due < today) return 'dc-overdue';
  if (due === today) return 'dc-today';
  if (due === tom) return 'dc-tomorrow';
  return 'dc-future';
}

/** チェックボックス丸ウィジェット (Se3b7a2-2) */
class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly lineNo: number,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.lineNo === this.lineNo;
  }

  override toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = this.checked ? 'task-checkbox checked' : 'task-checkbox';
    btn.setAttribute('data-testid', 'task-checkbox');
    btn.setAttribute('data-line', String(this.lineNo));
    btn.setAttribute('data-done', this.checked ? 'true' : 'false');
    btn.setAttribute('aria-label', this.checked ? '完了タスク' : '未完了タスク');
    btn.innerHTML = CHECK_SVG;
    btn.onmousedown = (e) => {
      e.preventDefault();
    };
    btn.onclick = (e) => {
      e.preventDefault();
      // ウィジェットは TaskMarker ([ ] / [x]) 全体を置換しているので、
      // 開始位置 +1 がチェック状態の 1 文字。
      const pos = view.posAtDOM(btn);
      const ch = view.state.doc.sliceString(pos + 1, pos + 2);
      const nowChecked = ch === 'x' || ch === 'X';
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: nowChecked ? ' ' : 'x' },
        userEvent: 'input.toggle-task',
      });
    };
    return btn;
  }
}

/** ステータスピル (Se3b7a2-2) */
class StatusPillWidget extends WidgetType {
  constructor(
    readonly statusKey: string,
    readonly vocab: TaskVocabRequired,
  ) { super(); }

  override eq(other: StatusPillWidget): boolean {
    return other.statusKey === this.statusKey;
  }

  override toDOM(): HTMLElement {
    const pill = document.createElement('span');
    pill.className = 'status-pill';
    pill.setAttribute('data-testid', 'status-pill');
    pill.setAttribute('data-status', this.statusKey);
    const entry = this.vocab.statuses.find((s) => s.key === this.statusKey);
    pill.textContent = entry?.label ?? this.statusKey;
    return pill;
  }
}

/** 優先度フラグ (Se3b7a2-2) */
class PriorityFlagWidget extends WidgetType {
  constructor(
    readonly priorityKey: string,
    readonly vocab: TaskVocabRequired,
  ) { super(); }

  override eq(other: PriorityFlagWidget): boolean {
    return other.priorityKey === this.priorityKey;
  }

  override toDOM(): HTMLElement {
    const flag = document.createElement('span');
    flag.className = 'priority-flag';
    flag.setAttribute('data-testid', 'priority-flag');
    flag.setAttribute('data-priority', this.priorityKey);
    flag.innerHTML = FLAG_OUTLINE_SVG;
    const entry = this.vocab.priorities.find((p) => p.key === this.priorityKey);
    flag.append(document.createTextNode(entry?.label ?? this.priorityKey));
    return flag;
  }
}

/** 期日チップ (Se3b7a2-2) */
class DueChipWidget extends WidgetType {
  constructor(readonly due: string) { super(); }

  override eq(other: DueChipWidget): boolean {
    return other.due === this.due;
  }

  override toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = `due-chip ${dueCssClass(this.due)}`;
    chip.setAttribute('data-testid', 'due-chip');
    chip.innerHTML = CAL_SMALL_SVG;
    chip.append(document.createTextNode(this.due));
    return chip;
  }
}

/** クイック編集トリガーボタン (ギアアイコン — Se3b7a2-2) */
class CheckboxFieldsTriggerWidget extends WidgetType {
  constructor(
    readonly lineNo: number,
    readonly lineText: string,
  ) { super(); }

  override eq(other: CheckboxFieldsTriggerWidget): boolean {
    return other.lineNo === this.lineNo && other.lineText === this.lineText;
  }

  override toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'checkbox-fields-trigger';
    btn.setAttribute('data-testid', 'checkbox-fields-trigger');
    btn.setAttribute('data-line', String(this.lineNo));
    btn.setAttribute('aria-label', 'ステータス・期限・優先度を編集');
    btn.innerHTML = GEAR_SVG;
    btn.onmousedown = (e) => { e.preventDefault(); };
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openCheckboxFieldsPopover(view, this.lineNo, this.lineText, btn);
    };
    return btn;
  }
}

// ---- クイック編集ポップオーバー (Se3b7a2-2) ----------------------------------

interface PopoverEditorState {
  status: string | null;
  priority: string | null;
  due: string | null;
  calYear: number;
  calMonth: number;
}

async function openCheckboxFieldsPopover(
  view: EditorView,
  lineNo: number,
  lineText: string,
  triggerEl: HTMLElement,
): Promise<void> {
  // 既存のポップオーバーがあれば閉じる
  const existing = document.querySelector('.checkbox-fields-popover');
  if (existing !== null) { existing.remove(); if (existing.getAttribute('data-line') === String(lineNo)) return; }

  // triggerRect は非同期処理前に取得 (getVocab() 待機中に DOM から外れる可能性があるため)
  const triggerRect = triggerEl.getBoundingClientRect();

  const vocab = await getVocab();
  const fields = extractInlineFields(lineText);

  const st: PopoverEditorState = {
    status: fields.status,
    priority: fields.priority,
    due: fields.due,
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
  };

  const pop = document.createElement('div');
  pop.className = 'checkbox-fields-popover';
  pop.setAttribute('data-testid', 'checkbox-fields-popover');
  pop.setAttribute('data-line', String(lineNo));

  // --- Status section ---
  const secSt = document.createElement('div');
  secSt.className = 'tqe-section';
  const lblSt = document.createElement('div');
  lblSt.className = 'tqe-section-label';
  lblSt.textContent = 'ステータス';
  const stOpts = document.createElement('div');
  stOpts.className = 'tqe-status-opts';

  const renderStOpts = (): void => {
    stOpts.replaceChildren();
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = st.status === null ? 'tqe-status-opt active' : 'tqe-status-opt';
    noneBtn.setAttribute('data-status', 'none');
    noneBtn.setAttribute('data-testid', 'status-opt-none');
    const noneG = document.createElement('span');
    noneG.className = 'so-glyph';
    const noneC = document.createElement('span');
    noneC.className = 'so-check';
    noneC.textContent = '✓';
    noneBtn.append(noneG, document.createTextNode('なし'), noneC);
    noneBtn.addEventListener('click', () => { st.status = null; renderStOpts(); });
    stOpts.append(noneBtn);
    for (const s of vocab.statuses) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = st.status === s.key ? 'tqe-status-opt active' : 'tqe-status-opt';
      btn.setAttribute('data-status', s.key);
      btn.setAttribute('data-testid', `status-opt-${s.key}`);
      const g = document.createElement('span');
      g.className = 'so-glyph';
      const c = document.createElement('span');
      c.className = 'so-check';
      c.textContent = '✓';
      btn.append(g, document.createTextNode(s.label), c);
      const sKey = s.key;
      btn.addEventListener('click', () => { st.status = sKey; renderStOpts(); });
      stOpts.append(btn);
    }
  };
  renderStOpts();
  secSt.append(lblSt, stOpts);

  // --- Due section ---
  const secDue = document.createElement('div');
  secDue.className = 'tqe-section';
  const lblDue = document.createElement('div');
  lblDue.className = 'tqe-section-label';
  lblDue.textContent = '期限';
  const presets = document.createElement('div');
  presets.className = 'tqe-presets';

  const renderPresets = (): void => {
    presets.replaceChildren();
    const items = [
      { label: '今日', val: todayStr(), testid: 'due-preset-today' },
      { label: '明日', val: tomorrowStr(), testid: 'due-preset-tomorrow' },
      { label: '来週', val: nextWeekStr(), testid: 'due-preset-nextweek' },
    ];
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = st.due === item.val ? 'tqe-preset-btn active' : 'tqe-preset-btn';
      btn.setAttribute('data-testid', item.testid);
      btn.textContent = item.label;
      btn.addEventListener('click', () => { st.due = item.val; renderPresets(); renderCal(); });
      presets.append(btn);
    }
    if (st.due !== null) {
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'tqe-preset-btn clear';
      clr.setAttribute('data-testid', 'due-preset-clear');
      clr.textContent = 'クリア';
      clr.addEventListener('click', () => { st.due = null; renderPresets(); renderCal(); });
      presets.append(clr);
    }
  };
  renderPresets();

  const cal = document.createElement('div');
  cal.className = 'tqe-calendar';
  cal.setAttribute('data-testid', 'due-calendar');
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const renderCal = (): void => {
    cal.replaceChildren();
    const { calYear: y, calMonth: m } = st;
    const hdr = document.createElement('div');
    hdr.className = 'tqe-cal-header';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
    prev.addEventListener('click', () => {
      if (st.calMonth === 0) { st.calMonth = 11; st.calYear--; } else { st.calMonth--; }
      renderCal();
    });
    const mlbl = document.createElement('span');
    mlbl.textContent = `${String(y)}年 ${String(m + 1)}月`;
    const next = document.createElement('button');
    next.type = 'button';
    next.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
    next.addEventListener('click', () => {
      if (st.calMonth === 11) { st.calMonth = 0; st.calYear++; } else { st.calMonth++; }
      renderCal();
    });
    hdr.append(prev, mlbl, next);
    const grid = document.createElement('div');
    grid.className = 'tqe-cal-grid';
    for (const d of DOW) {
      const dw = document.createElement('div');
      dw.className = 'tqe-cal-dow';
      dw.textContent = d;
      grid.append(dw);
    }
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < firstDay; i++) {
      const ph = document.createElement('div');
      ph.className = 'tqe-cal-day other-month';
      grid.append(ph);
    }
    const today = todayStr();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${String(y)}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cell = document.createElement('div');
      cell.className = 'tqe-cal-day';
      if (dateStr === today) cell.classList.add('today');
      if (dateStr === st.due) cell.classList.add('selected');
      cell.textContent = String(d);
      cell.setAttribute('data-testid', 'cal-day');
      cell.setAttribute('data-date', dateStr);
      cell.addEventListener('click', () => { st.due = dateStr; renderPresets(); renderCal(); });
      grid.append(cell);
    }
    cal.append(hdr, grid);
  };
  renderCal();
  secDue.append(lblDue, presets, cal);

  // --- Priority section ---
  const secPri = document.createElement('div');
  secPri.className = 'tqe-section';
  const lblPri = document.createElement('div');
  lblPri.className = 'tqe-section-label';
  lblPri.textContent = '優先度';
  const priOpts = document.createElement('div');
  priOpts.className = 'tqe-priority-opts';
  const renderPriOpts = (): void => {
    priOpts.replaceChildren();
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = st.priority === null ? 'tqe-priority-opt selected' : 'tqe-priority-opt';
    noneBtn.setAttribute('data-val', 'none');
    noneBtn.setAttribute('data-testid', 'priority-opt-none');
    const noneDot = document.createElement('span');
    noneDot.className = 'pf-dot';
    const noneChk = document.createElement('span');
    noneChk.className = 'check-mark';
    if (st.priority === null) noneChk.innerHTML = CHECK_MARK_SVG;
    noneBtn.append(noneDot, document.createTextNode('なし'), noneChk);
    noneBtn.addEventListener('click', () => { st.priority = null; renderPriOpts(); });
    priOpts.append(noneBtn);
    for (const p of vocab.priorities) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = st.priority === p.key ? 'tqe-priority-opt selected' : 'tqe-priority-opt';
      btn.setAttribute('data-val', p.key);
      btn.setAttribute('data-testid', `priority-opt-${p.key}`);
      const dot = document.createElement('span');
      dot.className = 'pf-dot';
      const chk = document.createElement('span');
      chk.className = 'check-mark';
      if (st.priority === p.key) chk.innerHTML = CHECK_MARK_SVG;
      btn.append(dot, document.createTextNode(p.label), chk);
      const pKey = p.key;
      btn.addEventListener('click', () => { st.priority = pKey; renderPriOpts(); });
      priOpts.append(btn);
    }
  };
  renderPriOpts();
  secPri.append(lblPri, priOpts);

  // --- Footer ---
  const footer = document.createElement('div');
  footer.className = 'tqe-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.setAttribute('data-testid', 'checkbox-fields-cancel');
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', () => { pop.remove(); });
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-sm btn-primary';
  applyBtn.setAttribute('data-testid', 'checkbox-fields-apply');
  applyBtn.textContent = '適用';
  applyBtn.addEventListener('click', () => {
    void applyCheckboxFields(view, lineNo, lineText, st.status, st.priority, st.due, pop);
  });
  footer.append(cancelBtn, applyBtn);

  // セクションをスクロール可能なボディに包み、フッタを常時表示する
  const cbBody = document.createElement('div');
  cbBody.className = 'tqe-popover-body';
  cbBody.append(secSt, secDue, secPri);
  pop.append(cbBody, footer);

  // ポップオーバーを document.body に固定位置で付加 (コードミラーの DOM 再描画に影響されない)
  pop.style.cssText =
    'position:fixed;z-index:500;background:var(--bg-editor,#fff);' +
    'border:1px solid var(--border-strong,#ccc);border-radius:12px;' +
    'padding:0;display:flex;flex-direction:column;max-height:min(80vh,520px);' +
    'box-shadow:0 4px 24px rgba(0,0,0,.18);min-width:280px;max-width:340px;overflow:hidden;';

  document.body.append(pop);

  // 位置決め: 取得後に設定。top をビューポート内にクランプする
  const popW = pop.offsetWidth || 300;
  const popH = pop.offsetHeight || 380;
  const left = Math.min(triggerRect.left, window.innerWidth - popW - 8);
  const rawTop = triggerRect.bottom + 4;
  const top = Math.min(rawTop, window.innerHeight - popH - 8);
  pop.style.left = `${String(Math.max(8, Math.round(left)))}px`;
  pop.style.top = `${String(Math.max(8, Math.round(top)))}px`;

  // クリックアウトサイドで閉じる。
  // mousedown (非キャプチャ) + contains() で判定: キャプチャフェーズでは
  // document ハンドラが popover より先に呼ばれるため _insidePop フラグが常に
  // false になり内側クリックでも閉じてしまうバグ (Bug-2) を修正した。
  const closeOnOutside = (e: MouseEvent): void => {
    if (pop.contains(e.target as Node)) return; // 内側クリック → 維持
    if (e.target === triggerEl) return;
    pop.remove();
    document.removeEventListener('mousedown', closeOnOutside);
  };
  setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 0);
}

async function applyCheckboxFields(
  view: EditorView,
  lineNo: number,
  lineText: string,
  status: string | null,
  priority: string | null,
  due: string | null,
  pop: HTMLElement,
): Promise<void> {
  const notePath = view.state.facet(notePathFacet);
  if (notePath.length === 0) { pop.remove(); return; }

  let newLine = lineText;
  // status
  const curFields = extractInlineFields(lineText);
  if (status !== curFields.status) {
    newLine = setInlineField(newLine, 'status', status ?? undefined);
  }
  if (priority !== curFields.priority) {
    newLine = setInlineField(newLine, 'priority', priority ?? undefined);
  }
  if (due !== curFields.due) {
    newLine = setInlineField(newLine, 'due', due ?? undefined);
  }
  if (newLine === lineText) { pop.remove(); return; }

  pop.remove();
  try {
    await api.patchNote(notePath, lineText, newLine);
    // 成功時: ドキュメントの該当行を更新 (エディタのバッファも同期)
    const state = view.state;
    const line = state.doc.line(lineNo);
    if (line.text === lineText) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: newLine },
        userEvent: 'input.update-task-fields',
      });
    }
  } catch (err: unknown) {
    // 409: ambiguous — ステータスバーには表示しない (シンプルに無視)
    void err;
  }
}

// ---- スラッシュメニュー /task 用 クイック設定ポップオーバー (Se3b7a2-7) --------

/**
 * スラッシュメニューで /task を選んだ直後に開くポップオーバー。
 * ステータス・優先度・期限をディスクリートなフィールドピッカー (チップ/カレンダー) で
 * 設定できる。すべてオプション (デフォルト: なし) → 何も選ばずキャンセルしても
 * `- [ ] ` だけが挿入された状態で問題ない。
 *
 * 適用時は API を経由せず直接エディタのバッファに書き込む (新規挿入行のため)。
 *
 * @param view    EditorView
 * @param lineNo  挿入された行の行番号
 * @param anchorRect  ポップオーバーの基準矩形 (エディタ DOM の getBoundingClientRect 等)
 */
export async function openTaskSlashPopover(
  view: EditorView,
  lineNo: number,
  anchorRect: DOMRect,
): Promise<void> {
  // 既存のポップオーバーがあれば閉じる
  const existingQuick = document.querySelector('.task-quick-popover');
  if (existingQuick !== null) { existingQuick.remove(); }

  const vocab = await getVocab();

  const st: PopoverEditorState = {
    status: null,
    priority: null,
    due: null,
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
  };

  const pop = document.createElement('div');
  pop.className = 'task-quick-popover';
  pop.setAttribute('data-testid', 'task-quick-popover');

  // --- ヘッダ ---
  const hdr = document.createElement('div');
  hdr.className = 'tqe-popover-header';
  const hdrTitle = document.createElement('span');
  hdrTitle.textContent = 'タスクの属性を設定（すべてオプション）';
  hdrTitle.className = 'tqe-popover-title';
  hdr.append(hdrTitle);
  // hdr は後で body・footer と一緒に pop.append する (順序を保証するため)

  // --- Status section ---
  const secSt = document.createElement('div');
  secSt.className = 'tqe-section';
  const lblSt = document.createElement('div');
  lblSt.className = 'tqe-section-label';
  lblSt.textContent = 'ステータス';
  const stOpts = document.createElement('div');
  stOpts.className = 'tqe-status-opts';
  stOpts.setAttribute('data-testid', 'task-popover-status');

  const renderStOpts = (): void => {
    stOpts.replaceChildren();
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = st.status === null ? 'tqe-status-opt active' : 'tqe-status-opt';
    noneBtn.setAttribute('data-status', 'none');
    noneBtn.setAttribute('data-testid', 'status-opt-none');
    const noneG = document.createElement('span');
    noneG.className = 'so-glyph';
    const noneC = document.createElement('span');
    noneC.className = 'so-check';
    noneC.textContent = '✓';
    noneBtn.append(noneG, document.createTextNode('なし'), noneC);
    noneBtn.addEventListener('click', () => { st.status = null; renderStOpts(); });
    stOpts.append(noneBtn);
    for (const s of vocab.statuses) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = st.status === s.key ? 'tqe-status-opt active' : 'tqe-status-opt';
      btn.setAttribute('data-status', s.key);
      btn.setAttribute('data-testid', `status-opt-${s.key}`);
      const g = document.createElement('span');
      g.className = 'so-glyph';
      const c = document.createElement('span');
      c.className = 'so-check';
      c.textContent = '✓';
      btn.append(g, document.createTextNode(s.label), c);
      const sKey = s.key;
      btn.addEventListener('click', () => { st.status = sKey; renderStOpts(); });
      stOpts.append(btn);
    }
  };
  renderStOpts();
  secSt.append(lblSt, stOpts);

  // --- Due section ---
  const secDue = document.createElement('div');
  secDue.className = 'tqe-section';
  const lblDue = document.createElement('div');
  lblDue.className = 'tqe-section-label';
  lblDue.textContent = '期限';
  const presets = document.createElement('div');
  presets.className = 'tqe-presets';

  const renderPresets = (): void => {
    presets.replaceChildren();
    const nonePreset = document.createElement('button');
    nonePreset.type = 'button';
    nonePreset.className = st.due === null ? 'tqe-preset-btn active' : 'tqe-preset-btn';
    nonePreset.setAttribute('data-testid', 'due-preset-none');
    nonePreset.textContent = 'なし';
    nonePreset.addEventListener('click', () => { st.due = null; renderPresets(); renderCal(); });
    presets.append(nonePreset);
    const items = [
      { label: '今日', val: todayStr(), testid: 'due-preset-today' },
      { label: '明日', val: tomorrowStr(), testid: 'due-preset-tomorrow' },
      { label: '来週', val: nextWeekStr(), testid: 'due-preset-nextweek' },
    ];
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = st.due === item.val ? 'tqe-preset-btn active' : 'tqe-preset-btn';
      btn.setAttribute('data-testid', item.testid);
      btn.textContent = item.label;
      btn.addEventListener('click', () => { st.due = item.val; renderPresets(); renderCal(); });
      presets.append(btn);
    }
  };
  renderPresets();

  const cal = document.createElement('div');
  cal.className = 'tqe-calendar';
  cal.setAttribute('data-testid', 'task-due-cal');
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const renderCal = (): void => {
    cal.replaceChildren();
    const { calYear: y, calMonth: m } = st;
    const cHdr = document.createElement('div');
    cHdr.className = 'tqe-cal-header';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
    prev.addEventListener('click', () => {
      if (st.calMonth === 0) { st.calMonth = 11; st.calYear--; } else { st.calMonth--; }
      renderCal();
    });
    const mlbl = document.createElement('span');
    mlbl.textContent = `${String(y)}年 ${String(m + 1)}月`;
    const next = document.createElement('button');
    next.type = 'button';
    next.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
    next.addEventListener('click', () => {
      if (st.calMonth === 11) { st.calMonth = 0; st.calYear++; } else { st.calMonth++; }
      renderCal();
    });
    cHdr.append(prev, mlbl, next);
    const grid = document.createElement('div');
    grid.className = 'tqe-cal-grid';
    for (const d of DOW) {
      const dw = document.createElement('div');
      dw.className = 'tqe-cal-dow';
      dw.textContent = d;
      grid.append(dw);
    }
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < firstDay; i++) {
      const ph = document.createElement('div');
      ph.className = 'tqe-cal-day other-month';
      grid.append(ph);
    }
    const today = todayStr();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${String(y)}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cell = document.createElement('div');
      cell.className = 'tqe-cal-day';
      if (dateStr === today) cell.classList.add('today');
      if (dateStr === st.due) cell.classList.add('selected');
      cell.textContent = String(d);
      cell.setAttribute('data-testid', 'cal-day');
      cell.setAttribute('data-date', dateStr);
      cell.addEventListener('click', () => { st.due = dateStr; renderPresets(); renderCal(); });
      grid.append(cell);
    }
    cal.append(cHdr, grid);
  };
  renderCal();
  secDue.append(lblDue, presets, cal);

  // --- Priority section ---
  const secPri = document.createElement('div');
  secPri.className = 'tqe-section';
  const lblPri = document.createElement('div');
  lblPri.className = 'tqe-section-label';
  lblPri.textContent = '優先度';
  const priOpts = document.createElement('div');
  priOpts.className = 'tqe-priority-opts';
  priOpts.setAttribute('data-testid', 'task-popover-priority');
  const renderPriOpts = (): void => {
    priOpts.replaceChildren();
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = st.priority === null ? 'tqe-priority-opt selected' : 'tqe-priority-opt';
    noneBtn.setAttribute('data-val', 'none');
    noneBtn.setAttribute('data-testid', 'priority-opt-none');
    const noneDot = document.createElement('span');
    noneDot.className = 'pf-dot';
    const noneChk = document.createElement('span');
    noneChk.className = 'check-mark';
    if (st.priority === null) noneChk.innerHTML = CHECK_MARK_SVG;
    noneBtn.append(noneDot, document.createTextNode('なし'), noneChk);
    noneBtn.addEventListener('click', () => { st.priority = null; renderPriOpts(); });
    priOpts.append(noneBtn);
    for (const p of vocab.priorities) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = st.priority === p.key ? 'tqe-priority-opt selected' : 'tqe-priority-opt';
      btn.setAttribute('data-val', p.key);
      btn.setAttribute('data-testid', `priority-opt-${p.key}`);
      const dot = document.createElement('span');
      dot.className = 'pf-dot';
      const chk = document.createElement('span');
      chk.className = 'check-mark';
      if (st.priority === p.key) chk.innerHTML = CHECK_MARK_SVG;
      btn.append(dot, document.createTextNode(p.label), chk);
      const pKey = p.key;
      btn.addEventListener('click', () => { st.priority = pKey; renderPriOpts(); });
      priOpts.append(btn);
    }
  };
  renderPriOpts();
  secPri.append(lblPri, priOpts);

  // --- Footer ---
  const footer = document.createElement('div');
  footer.className = 'tqe-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.setAttribute('data-testid', 'task-quick-popover-cancel');
  cancelBtn.textContent = 'スキップ';
  cancelBtn.addEventListener('click', () => { pop.remove(); view.focus(); });
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-sm btn-primary';
  applyBtn.setAttribute('data-testid', 'task-quick-popover-apply');
  applyBtn.textContent = '挿入';
  applyBtn.addEventListener('click', () => {
    const state = view.state;
    const line = state.doc.line(lineNo);
    let newText = line.text;
    if (st.status !== null) newText = setInlineField(newText, 'status', st.status);
    if (st.priority !== null) newText = setInlineField(newText, 'priority', st.priority);
    if (st.due !== null) newText = setInlineField(newText, 'due', st.due);
    if (newText !== line.text) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: newText },
        userEvent: 'input.update-task-fields',
      });
    }
    pop.remove();
    view.focus();
  });
  footer.append(cancelBtn, applyBtn);

  // ボディ: セクションをスクロール可能なラッパーに包む (フッタを常時表示するため)
  const body = document.createElement('div');
  body.className = 'tqe-popover-body';
  body.append(secSt, secDue, secPri);
  pop.append(hdr, body, footer);

  // ポップオーバースタイル (overflow は .task-quick-popover CSS クラスで管理)
  pop.style.cssText =
    'position:fixed;z-index:500;background:var(--bg-editor,#fff);' +
    'border:1px solid var(--border-strong,#ccc);border-radius:12px;' +
    'padding:0;box-shadow:0 4px 24px rgba(0,0,0,.18);min-width:280px;max-width:340px;';

  document.body.append(pop);

  // 位置決め: ビューポート内に収まるよう top を上方向にクランプする
  const popW = pop.offsetWidth || 300;
  const popH = pop.offsetHeight || 400;
  const left = Math.min(anchorRect.left + 40, window.innerWidth - popW - 8);
  const rawTop = anchorRect.top + 60;
  const top = Math.min(rawTop, window.innerHeight - popH - 8);
  pop.style.left = `${String(Math.max(8, Math.round(left)))}px`;
  pop.style.top = `${String(Math.max(8, Math.round(top)))}px`;

  // クリックアウトサイドで閉じる。
  // mousedown (非キャプチャ) + contains() で判定: キャプチャフェーズでは
  // document ハンドラが popover より先に呼ばれるため _insidePop フラグが常に
  // false になり内側クリックでも閉じてしまうバグ (Bug-2) を修正した。
  const closeOnOutside = (e: MouseEvent): void => {
    if (pop.contains(e.target as Node)) return; // 内側クリック → 維持
    pop.remove();
    document.removeEventListener('mousedown', closeOnOutside);
  };
  setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 0);
}

/** 箇条書きマーカー (- / * / +) を深さ別の装飾ドットへ置換するウィジェット。 */
class BulletWidget extends WidgetType {
  constructor(readonly glyph: string) {
    super();
  }

  override eq(other: BulletWidget): boolean {
    return other.glyph === this.glyph;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-list-bullet';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.glyph;
    return span;
  }
}

/** 入れ子深さ別のドット (0: • / 1: ◦ / 2: ▪ で循環)。 */
const BULLET_GLYPHS = ['•', '◦', '▪'];

/** ListItem の入れ子深さ (0 始まり = 祖先の List ノード数 - 1)。 */
function listDepth(node: SyntaxNode): number {
  let lists = 0;
  for (let p = node.parent; p !== null; p = p.parent) {
    if (p.name === 'BulletList' || p.name === 'OrderedList') lists++;
  }
  return Math.max(0, lists - 1);
}

/**
 * リスト装飾 (チェックボックス + 箇条書きドット + ピル + トリガー) を構築する。
 *
 * チェックボックス判定は lezer の `TaskMarker` に頼らず、ListItem のマーカー直後の
 * 行頭 `[ ]` / `[x]` / `[X]` を直接見る。lezer-markdown の TaskList は `]` の直後に
 * 空白を要求するため、`- [ ]` (末尾 = 空タスク) や `- [x]` (リンクとして誤解析) を
 * 取りこぼす。これが「TODO がチェックボックスにならない場合がある」の原因だった。
 * ListItem 経由なのでコードフェンス内などは自然に除外される。
 *
 * Se3b7a2-2: チェックボックスは丸 (data-done)。インラインフィールドがあれば
 * 非アクティブ行に status-pill / priority-flag / due-chip ウィジェットを追加。
 * 行末に checkbox-fields-trigger を追加し、クリックでポップオーバーを開く。
 * インラインフィールドテキスト自体は置換せず残す (アクティブ行でソース表示される)。
 */
function buildListDecorations(view: EditorView, vocab: TaskVocabRequired): DecorationSet {
  const widgets: ReturnType<Decoration['range']>[] = [];
  const state = view.state;
  const active = activeLines(state);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'ListItem') return;
        const line = state.doc.lineAt(node.from);
        if (active.has(line.number)) return; // カーソル行はソース表示
        // ListItem 直下の ListMark (- / * / + / 1. …) を探す。
        let markFrom = -1;
        let markTo = -1;
        const cur = node.node.cursor();
        if (cur.firstChild()) {
          do {
            if (cur.name === 'ListMark') {
              markFrom = cur.from;
              markTo = cur.to;
              break;
            }
          } while (cur.nextSibling());
        }
        if (markTo < 0) return;
        const markChar = state.doc.sliceString(markFrom, markFrom + 1);
        const isBullet = markChar === '-' || markChar === '*' || markChar === '+';
        // マーカー直後〜行末からタスク記法 `[ ]` を直接検出 (空白/EOL が続くもの限定)。
        const rest = state.doc.sliceString(markTo, line.to);
        const task = /^\s+\[([ xX])\](?=\s|$)/.exec(rest);
        if (task !== null) {
          const bracketFrom = markTo + task[0].length - 3;
          const checked = task[1] === 'x' || task[1] === 'X';
          // 箇条書きタスクはマーカー("- "等)を隠してチェックボックス単独にする。
          if (isBullet) {
            widgets.push(Decoration.replace({}).range(markFrom, bracketFrom));
          }
          widgets.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(checked, line.number),
            }).range(bracketFrom, bracketFrom + 3),
          );
          // Se3b7a2-2: インラインフィールドのピルウィジェット + trigger。
          // Bug fix: フィールドテキスト ([due:: ...] 等) を REPLACE decoration で
          // ピルウィジェットに置き換え、ソーステキストとピルが二重表示されないようにする。
          // カーソル行はこのブロックに入らない (active.has チェック済み)。
          const lineText = line.text;
          const fields = extractInlineFields(lineText);

          // インラインフィールドの正規表現 (共有パッケージの INLINE_FIELD_RE と同一)
          const fieldRe = /\[([a-zA-Z][a-zA-Z0-9_-]*)::[ \t]*([^\]]*)\]/g;
          fieldRe.lastIndex = 0;
          let fm: RegExpExecArray | null;
          while ((fm = fieldRe.exec(lineText)) !== null) {
            const key = (fm[1] ?? '').toLowerCase();
            const rawVal = (fm[2] ?? '').trim();
            if (key !== 'status' && key !== 'priority' && key !== 'due') continue;
            const matchFrom = line.from + fm.index;
            const matchTo = matchFrom + fm[0].length;
            if (key === 'status' && fields.status !== null) {
              widgets.push(
                Decoration.replace({
                  widget: new StatusPillWidget(fields.status, vocab),
                }).range(matchFrom, matchTo),
              );
            } else if (key === 'due' && fields.due !== null) {
              widgets.push(
                Decoration.replace({
                  widget: new DueChipWidget(fields.due),
                }).range(matchFrom, matchTo),
              );
            } else if (key === 'priority' && fields.priority !== null) {
              widgets.push(
                Decoration.replace({
                  widget: new PriorityFlagWidget(rawVal.normalize('NFC').toLowerCase(), vocab),
                }).range(matchFrom, matchTo),
              );
            }
          }
          // trigger ボタン (常に行末に追加)
          widgets.push(
            Decoration.widget({
              widget: new CheckboxFieldsTriggerWidget(line.number, lineText),
              side: 1,
            }).range(line.to),
          );
          return;
        }
        // 通常の箇条書き: マーカー文字を深さ別の装飾ドットへ置換 (数字リストは素のまま)。
        if (isBullet) {
          const glyph = BULLET_GLYPHS[listDepth(node.node) % BULLET_GLYPHS.length] ?? '•';
          widgets.push(
            Decoration.replace({ widget: new BulletWidget(glyph) }).range(markFrom, markTo),
          );
        }
      },
    });
  }
  return Decoration.set(widgets, true);
}

function makeListDecoPlugin(vocab: TaskVocabRequired): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildListDecorations(view, vocab);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = buildListDecorations(update.view, vocab);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---- 見出し折りたたみ (Sb6f1d3-1) ------------------------------------------
// セッションのみ有効: fold 状態は EditorState に保持され、EditorState.create で
// 消去される (ノート切替時にリセット)。localStorage/IndexedDB への永続化は一切行わない。

/**
 * ATX 見出し (# … ######) の見出しレベルを返す。
 * 見出しでなければ 0 を返す。lezer-markdown の ATXHeading1〜6 ノードを使う。
 */
function headingLevelAt(state: EditorState, line: Line): number {
  const tree = syntaxTree(state);
  let found = 0;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (m !== null) {
        found = Number(m[1]);
        return false;
      }
      // SetextHeading はレベルが ATXHeading と異なる命名になっていないが
      // lezer-markdown は SetextHeading1 / SetextHeading2 という名前を使う
      const sm = /^SetextHeading([12])$/.exec(node.name);
      if (sm !== null) {
        found = Number(sm[1]);
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/**
 * 見出し行の折りたたみ対象範囲。
 * from = 見出し行末、to = 次の同レベル以上の見出し直前 (または文書末)。
 * 配下にコンテンツ行がなければ null。
 *
 * Sb6f1d3-1: リストの foldableListRange と同一の命名規則。
 */
export function foldableHeadingRange(
  state: EditorState,
  line: Line,
): { from: number; to: number } | null {
  const level = headingLevelAt(state, line);
  if (level === 0) return null;

  // 次の同レベル以上の見出しを探す
  let endPos = state.doc.length;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    const lv = headingLevelAt(state, l);
    if (lv > 0 && lv <= level) {
      // この見出し行の直前 (前の行末) まで
      const prevLine = state.doc.line(n - 1);
      endPos = prevLine.to;
      break;
    }
  }

  // 配下にコンテンツがなければ null
  if (endPos <= line.to) return null;
  // 見出し行末から次の同レベル以上見出し直前まで
  return { from: line.to, to: endPos };
}

/** 行末から始まる見出し fold 済み範囲 (headingFoldGutter 用) */
function headingFoldedAt(state: EditorState, line: Line): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => {
    if (from === line.to) {
      found = { from, to };
      return false;
    }
    return undefined;
  });
  return found;
}

class HeadingFoldToggleMarker extends GutterMarker {
  constructor(
    readonly lineNo: number,
    readonly level: number,
    readonly folded: boolean,
  ) {
    super();
  }

  override eq(other: HeadingFoldToggleMarker): boolean {
    return (
      other.lineNo === this.lineNo &&
      other.level === this.level &&
      other.folded === this.folded
    );
  }

  override toDOM(): Node {
    const btn = document.createElement('button');
    btn.className = this.folded
      ? 'heading-fold-toggle folded'
      : 'heading-fold-toggle';
    btn.setAttribute('data-testid', 'heading-fold-toggle');
    btn.setAttribute('data-line', String(this.lineNo));
    btn.setAttribute('data-level', String(this.level));
    if (this.folded) {
      btn.setAttribute('data-folded', 'true');
      btn.title = 'セクションを展開する (Ctrl-Shift-])';
      btn.setAttribute('aria-label', '折りたたまれた見出しセクション — クリックで展開');
    } else {
      btn.title = 'セクションを折りたたむ (Ctrl-Shift-[)';
      btn.setAttribute('aria-label', '見出しセクションを折りたたむ');
    }
    btn.innerHTML = CHEVRON_DOWN; // CSS transform で folded 時は回転させる
    return btn;
  }
}

const headingFoldGutter: Extension = gutter({
  class: 'cm-heading-fold-gutter',
  lineMarker(view, block) {
    const line = view.state.doc.lineAt(block.from);
    if (foldableHeadingRange(view.state, line) === null) return null;
    const level = headingLevelAt(view.state, line);
    if (level === 0) return null;
    return new HeadingFoldToggleMarker(
      line.number,
      level,
      headingFoldedAt(view.state, line) !== null,
    );
  },
  lineMarkerChange: (update) =>
    update.docChanged || update.viewportChanged || isFoldTransaction(update),
  domEventHandlers: {
    click(view, block) {
      const line = view.state.doc.lineAt(block.from);
      const folded = headingFoldedAt(view.state, line);
      if (folded !== null) {
        view.dispatch({ effects: unfoldEffect.of(folded) });
        return true;
      }
      const range = foldableHeadingRange(view.state, line);
      if (range === null) return false;
      view.dispatch({ effects: foldEffect.of(range) });
      return true;
    },
  },
});

/** 見出し fold キーボードショートカット (Ctrl-Shift-[ / Ctrl-Shift-]) */
const headingFoldKeymap: Extension = Prec.high(
  keymap.of([
    {
      key: 'Ctrl-Shift-[',
      mac: 'Cmd-Alt-[',
      run(view) {
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const range = foldableHeadingRange(view.state, line);
        if (range === null) return false; // 見出し行でなければキーを消費しない
        view.dispatch({ effects: foldEffect.of(range) });
        return true;
      },
    },
    {
      key: 'Ctrl-Shift-]',
      mac: 'Cmd-Alt-]',
      run(view) {
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        if (headingLevelAt(view.state, line) === 0) return false;
        const folded = headingFoldedAt(view.state, line);
        if (folded === null) return false;
        view.dispatch({ effects: unfoldEffect.of(folded) });
        return true;
      },
    },
  ]),
);

/** アウトライン操作一式 (Editor に登録する)。
 * タスク語彙は起動時に一度 GET /api/settings/tasks で取得 (失敗時は DEFAULT_TASK_VOCAB)。
 */
export function outlineExtension(): Extension {
  // 語彙は非同期に取得するが、Extension は同期で返す必要があるため
  // まず DEFAULT_TASK_VOCAB で作成し、取得後にキャッシュを更新する (次回ビュー更新で反映)。
  const plugin = makeListDecoPlugin(DEFAULT_TASK_VOCAB);
  // バックグラウンドで語彙を取得してキャッシュに保存 (makeListDecoPlugin の再実行は不要 —
  // getVocab() のキャッシュ (_cachedVocab) を popover 側で共有するため)。
  void getVocab();
  // headingFoldGutter / headingFoldKeymap を outlineFolding / outlineFoldGutter と共存させる。
  // 共通の codeFolding() (outlineFolding) を 1 つだけ使い、fold state の二重管理を避ける。
  return [outlineFolding, outlineFoldGutter, headingFoldGutter, headingFoldKeymap, outlineKeymap, plugin];
}
