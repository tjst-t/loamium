/**
 * ```dataview フェンスレンダラー (Sb1593c-2 — prototype/dataview.html 準拠)。
 *
 * - fence レジストリに mode: replace で登録。カーソルがフェンス行に入ると
 *   ソース表示へ戻る (既存 fence 機構)
 * - POST /api/query の結果を LIST / TABLE / TASK として描画する
 *   (dataview-widget[data-query-type])。結果クリックで元ノート (TASK は該当行) へ移動
 * - 構文エラー (400 query_syntax) はフェンス内に位置情報 + キャレット付きで表示し、
 *   エディタの編集は妨げない (dataview-error)
 * - vault のファイル変更に追従: 描画後は widget の DOM が生きている間だけ
 *   ポーリング (実質デバウンス) で再実行し、結果が変わったときのみ再描画する。
 *   すべて表示層のみ — ファイル (ピュア Markdown) は一切変更しない (priority 1)
 * - Se3b7a2-4/5: TASK 行は div[role="button"] + 丸チェックボックス + status/priority/due ピル。
 *   indent > 0 の行は親の子として折りたたみ可能 (デフォルト collapsed)。
 *   チェックボックスクリック → patchNote。編集ボタン → インライン popover。
 */
import type { ListQueryRow, QueryResponse, TableCellValue, TaskQueryRow, TaskVocabRequired } from '@loamium/shared';
import { DEFAULT_TASK_VOCAB, setInlineField } from '@loamium/shared';
import { api, ApiError, QueryApiError } from '../api.js';
import { registerFenceRenderer, type RenderContext } from '../registries.js';

/** ファイル変更追従の再実行間隔 (ms)。連続変更はこの間隔にデバウンスされる */
export const DATAVIEW_REFRESH_MS = 2_000;

const NOTE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" class="file-ico"><path d="M4 1.8h5.2L12.2 4.8v9.4H4z"/><path d="M9.2 1.8v3h3"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>';

/** 固定 SVG 文字列 (上の定数のみ) をアイコン要素にする。vault 由来の文字列は通さない */
function icon(svg: string, className = ''): HTMLElement {
  const span = document.createElement('span');
  if (className.length > 0) span.className = className;
  span.innerHTML = svg;
  return span;
}

function titleOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

/**
 * 結果クリックのナビゲーション。click ではなく mousedown で扱う:
 * クリックでカーソルがフェンス行へ入ると装飾がソース表示に差し替わり
 * click イベントが届かないため (WikilinkWidget / embed ヘッダと同じ理由)。
 * fence-widget 全体の「クリックでソース編集」リスナーへも届かせない。
 */
function wireNavigation(el: HTMLElement, navigate: () => void): void {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    navigate();
  });
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---- 各クエリ種別の描画 ----------------------------------------------------------

function renderList(rows: ListQueryRow[], ctx: RenderContext): HTMLElement {
  const list = document.createElement('div');
  list.className = 'dv-list';
  for (const row of rows) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dv-item';
    item.setAttribute('data-testid', 'dataview-item');
    item.setAttribute('data-path', row.path);
    item.append(icon(NOTE_ICON, 'dv-ico'), document.createTextNode(row.title));
    if (row.folder.length > 0) {
      const folder = document.createElement('span');
      folder.className = 'path';
      folder.textContent = `${row.folder}/`;
      item.append(folder);
    }
    wireNavigation(item, () => ctx.env?.openNote(row.path));
    list.append(item);
  }
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dv-empty';
    empty.textContent = '0 件';
    list.append(empty);
  }
  return list;
}

function renderCell(value: TableCellValue, ctx: RenderContext): HTMLElement {
  const td = document.createElement('td');
  if (value === null) {
    td.textContent = '';
  } else if (Array.isArray(value)) {
    // tags 等の文字列配列はチップ表示 (prototype の dv-tag)
    for (const v of value) {
      const chip = document.createElement('span');
      chip.className = 'dv-tag';
      chip.setAttribute('data-testid', 'dataview-tag');
      chip.setAttribute('data-tag', v);
      chip.textContent = `#${v}`;
      // タグクリック → タグ検索ナビゲーション (S11493d-4)。
      // click はフェンス行に届かない場合があるため wireNavigation と同じ mousedown を使う。
      if (ctx.env?.openTag !== undefined) {
        const tagVal = v;
        const openTag = ctx.env.openTag.bind(ctx.env);
        wireNavigation(chip, () => openTag(tagVal));
        chip.style.cursor = 'pointer';
        chip.title = `#${tagVal} で検索`;
      }
      td.append(chip);
    }
  } else {
    td.textContent = String(value);
  }
  return td;
}

function renderTable(fields: string[], rows: { path: string; title: string; values: TableCellValue[] }[], ctx: RenderContext): HTMLElement {
  const table = document.createElement('table');
  table.className = 'dv-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of ['ノート', ...fields]) {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const noteTd = document.createElement('td');
    const link = document.createElement('span');
    link.className = 'dv-note-link';
    link.setAttribute('data-testid', 'dataview-item');
    link.setAttribute('data-path', row.path);
    link.textContent = row.title;
    wireNavigation(link, () => ctx.env?.openNote(row.path));
    noteTd.append(link);
    tr.append(noteTd);
    for (const value of row.values) tr.append(renderCell(value, ctx));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

// ---- TASK 行ポップオーバー ---------------------------------------------------

/** 今日の YYYY-MM-DD (ローカル時刻) */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** tomorrow の YYYY-MM-DD */
function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 来週月曜の YYYY-MM-DD */
function nextWeekStr(): string {
  const d = new Date();
  const day = d.getDay(); // 0=sun
  const daysToMon = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysToMon);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 期日の表示クラス (overdue / today / tomorrow / future) */
function dueCssClass(due: string): string {
  const today = todayStr();
  const tom = tomorrowStr();
  if (due < today) return 'dc-overdue';
  if (due === today) return 'dc-today';
  if (due === tom) return 'dc-tomorrow';
  return 'dc-future';
}

/** 期日の表示ラベル */
function dueLabel(due: string): string {
  const today = todayStr();
  const tom = tomorrowStr();
  if (due < today) {
    const days = Math.round((Date.parse(today) - Date.parse(due)) / 86400000);
    return `期限切れ ${String(days)}日`;
  }
  if (due === today) return '今日';
  if (due === tom) return '明日';
  // 日付を MM/D 形式で表示
  const m = due.slice(5, 7).replace(/^0/, '');
  const d = due.slice(8, 10).replace(/^0/, '');
  return `${m}/${d}`;
}

const CAL_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2.5" y="3" width="11" height="10.5" rx="2"/><path d="M2.5 7h11M5.5 1v3M10.5 1v3"/></svg>';
const EDIT_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a1.414 1.414 0 012 2L5 13H3v-2L11.5 2.5z"/></svg>';
const CHECK_MARK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4 4 6-7"/></svg>';
const FLAG_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h10l-2 4 2 4H5v4H3z"/></svg>';

interface DvPopoverState {
  status: string | null;
  priority: string | null;
  due: string | null;
  calYear: number;
  calMonth: number;
}

/** Dataview TASK 行の quick-edit popover を構築して返す。 */
function buildDvPopover(opts: {
  row: TaskQueryRow;
  vocab: TaskVocabRequired;
  onApply: (newStatus: string | null, newPriority: string | null, newDue: string | null) => Promise<void>;
  onClose: () => void;
}): HTMLElement {
  const { row, vocab, onApply, onClose } = opts;
  const now = new Date();

  const state: DvPopoverState = {
    status: row.status,
    priority: row.priority,
    due: row.due,
    calYear: now.getFullYear(),
    calMonth: now.getMonth(), // 0-based
  };

  const pop = document.createElement('div');
  pop.className = 'dv-task-popover';
  pop.setAttribute('data-testid', 'dv-task-popover');

  // --- Status section ---
  const secStatus = document.createElement('div');
  secStatus.className = 'dvp-section';
  const lblStatus = document.createElement('div');
  lblStatus.className = 'dvp-section-label';
  lblStatus.textContent = 'ステータス';
  const statusOpts = document.createElement('div');
  statusOpts.className = 'dvp-status-opts';

  const renderStatusOpts = (): void => {
    statusOpts.replaceChildren();
    // "なし" option
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = state.status === null ? 'dvp-status-opt active' : 'dvp-status-opt';
    noneBtn.setAttribute('data-status', 'none');
    noneBtn.setAttribute('data-testid', 'dvp-status-opt');
    noneBtn.setAttribute('data-val', 'none');
    const noneGlyph = document.createElement('span');
    noneGlyph.className = 'so-glyph';
    const noneCheck = document.createElement('span');
    noneCheck.className = 'dvp-so-check';
    noneCheck.textContent = '✓';
    noneBtn.append(noneGlyph, document.createTextNode('なし'), noneCheck);
    noneBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); state.status = null; renderStatusOpts(); });
    statusOpts.append(noneBtn);
    for (const s of vocab.statuses) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = state.status === s.key ? 'dvp-status-opt active' : 'dvp-status-opt';
      btn.setAttribute('data-status', s.key);
      btn.setAttribute('data-testid', 'dvp-status-opt');
      btn.setAttribute('data-val', s.key);
      const glyph = document.createElement('span');
      glyph.className = 'so-glyph';
      const chk = document.createElement('span');
      chk.className = 'dvp-so-check';
      chk.textContent = '✓';
      btn.append(glyph, document.createTextNode(s.label), chk);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.status = s.key;
        renderStatusOpts();
      });
      statusOpts.append(btn);
    }
  };
  renderStatusOpts();
  secStatus.append(lblStatus, statusOpts);

  // --- Due section ---
  const secDue = document.createElement('div');
  secDue.className = 'dvp-section';
  const lblDue = document.createElement('div');
  lblDue.className = 'dvp-section-label';
  lblDue.textContent = '期限';

  const presets = document.createElement('div');
  presets.className = 'dvp-presets';

  const renderPresets = (): void => {
    presets.replaceChildren();
    const presetsData = [
      { label: '今日', val: todayStr(), testid: 'dvp-preset-today' },
      { label: '明日', val: tomorrowStr(), testid: 'dvp-preset-tomorrow' },
      { label: '来週', val: nextWeekStr(), testid: 'dvp-preset-nextweek' },
    ];
    for (const p of presetsData) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = state.due === p.val ? 'dvp-preset-btn active' : 'dvp-preset-btn';
      btn.setAttribute('data-testid', p.testid);
      btn.textContent = p.label;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.due = p.val;
        renderPresets();
        renderCalendar();
      });
      presets.append(btn);
    }
    if (state.due !== null) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'dvp-preset-btn';
      clearBtn.setAttribute('data-testid', 'dvp-preset-clear');
      clearBtn.textContent = 'クリア';
      clearBtn.style.color = 'var(--danger)';
      clearBtn.style.borderColor = '#fecaca';
      clearBtn.style.background = '#fef2f2';
      clearBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.due = null;
        renderPresets();
        renderCalendar();
      });
      presets.append(clearBtn);
    }
  };
  renderPresets();

  // Calendar
  const cal = document.createElement('div');
  cal.className = 'dvp-calendar';
  cal.setAttribute('data-testid', 'dvp-calendar');

  const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  const renderCalendar = (): void => {
    cal.replaceChildren();
    const year = state.calYear;
    const month = state.calMonth;
    const header = document.createElement('div');
    header.className = 'dvp-cal-header';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
    prevBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.calMonth === 0) { state.calMonth = 11; state.calYear--; }
      else { state.calMonth--; }
      renderCalendar();
    });
    const monthLabel = document.createElement('span');
    monthLabel.textContent = `${String(year)}年 ${String(month + 1)}月`;
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
    nextBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.calMonth === 11) { state.calMonth = 0; state.calYear++; }
      else { state.calMonth++; }
      renderCalendar();
    });
    header.append(prevBtn, monthLabel, nextBtn);

    const grid = document.createElement('div');
    grid.className = 'dvp-cal-grid';
    for (const dow of DOW_LABELS) {
      const d = document.createElement('div');
      d.className = 'dvp-cal-dow';
      d.textContent = dow;
      grid.append(d);
    }
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayDate = todayStr();
    for (let i = 0; i < firstDay; i++) {
      const ph = document.createElement('div');
      ph.className = 'dvp-cal-day other-month';
      grid.append(ph);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${String(year)}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cell = document.createElement('div');
      cell.className = 'dvp-cal-day';
      if (dateStr === todayDate) cell.classList.add('today');
      if (dateStr === state.due) cell.classList.add('selected');
      cell.textContent = String(d);
      cell.setAttribute('data-testid', 'dvp-cal-day');
      cell.setAttribute('data-date', dateStr);
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.due = dateStr;
        renderPresets();
        renderCalendar();
      });
      grid.append(cell);
    }
    cal.append(header, grid);
  };
  renderCalendar();
  secDue.append(lblDue, presets, cal);

  // --- Priority section ---
  const secPri = document.createElement('div');
  secPri.className = 'dvp-section';
  const lblPri = document.createElement('div');
  lblPri.className = 'dvp-section-label';
  lblPri.textContent = '優先度';

  const priOpts = document.createElement('div');
  priOpts.className = 'dvp-priority-opts';

  const renderPriOpts = (): void => {
    priOpts.replaceChildren();
    // "なし" option
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = state.priority === null ? 'dvp-priority-opt selected' : 'dvp-priority-opt';
    noneBtn.setAttribute('data-val', 'none');
    noneBtn.setAttribute('data-testid', 'dvp-priority-opt');
    const noneDot = document.createElement('span');
    noneDot.className = 'pf-dot';
    const noneCheck = document.createElement('span');
    noneCheck.className = 'check-mark';
    if (state.priority === null) noneCheck.innerHTML = CHECK_MARK_SVG;
    noneBtn.append(noneDot, document.createTextNode('なし'), noneCheck);
    noneBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.priority = null;
      renderPriOpts();
    });
    priOpts.append(noneBtn);
    for (const p of vocab.priorities) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = state.priority === p.key ? 'dvp-priority-opt selected' : 'dvp-priority-opt';
      btn.setAttribute('data-val', p.key);
      btn.setAttribute('data-testid', 'dvp-priority-opt');
      const dot = document.createElement('span');
      dot.className = 'pf-dot';
      const chk = document.createElement('span');
      chk.className = 'check-mark';
      if (state.priority === p.key) chk.innerHTML = CHECK_MARK_SVG;
      btn.append(dot, document.createTextNode(p.label), chk);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.priority = p.key;
        renderPriOpts();
      });
      priOpts.append(btn);
    }
  };
  renderPriOpts();
  secPri.append(lblPri, priOpts);

  // --- Footer ---
  const footer = document.createElement('div');
  footer.className = 'dvp-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.setAttribute('data-testid', 'dv-task-popover-cancel');
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onClose(); });
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-sm btn-primary';
  applyBtn.setAttribute('data-testid', 'dv-task-popover-apply');
  applyBtn.textContent = '適用';
  applyBtn.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    void onApply(state.status, state.priority, state.due);
  });
  footer.append(cancelBtn, applyBtn);

  pop.append(secStatus, secDue, secPri, footer);
  return pop;
}

// ---- TASK ピル描画ヘルパー --------------------------------------------------

function makeStatusPill(statusKey: string, vocab: TaskVocabRequired): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'status-pill';
  pill.setAttribute('data-status', statusKey);
  pill.setAttribute('data-testid', 'status-pill');
  const entry = vocab.statuses.find((s) => s.key === statusKey);
  pill.textContent = entry?.label ?? statusKey;
  return pill;
}

function makePriorityFlag(priorityKey: string, vocab: TaskVocabRequired): HTMLElement {
  const flag = document.createElement('span');
  flag.className = 'dv-priority';
  flag.setAttribute('data-priority', priorityKey);
  flag.setAttribute('data-testid', 'dv-priority');
  flag.innerHTML = FLAG_SVG;
  const entry = vocab.priorities.find((p) => p.key === priorityKey);
  flag.append(document.createTextNode(entry?.label ?? priorityKey));
  return flag;
}

function makeDueChip(due: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `dv-due ${dueCssClass(due)}`;
  chip.setAttribute('data-testid', 'dv-due');
  chip.innerHTML = CAL_SVG;
  chip.append(document.createTextNode(dueLabel(due)));
  return chip;
}

// ---- TASK レンダラー本体 -----------------------------------------------------

function renderTasks(rows: TaskQueryRow[], ctx: RenderContext, vocab: TaskVocabRequired): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dv-tasks';

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dv-empty';
    empty.textContent = '0 件';
    wrap.append(empty);
    return wrap;
  }

  // indent > 0 の行は直前の indent===0 の親の子として格納する。
  // サーバーは path→行番号昇順に並べるので、indent順序は保証されている。

  interface TaskEntry {
    row: TaskQueryRow;
    children: TaskQueryRow[];
  }

  // グループ化: path ごと
  interface Group {
    path: string;
    entries: TaskEntry[];
  }

  const groups: Group[] = [];
  let currentGroup: Group | null = null;
  let currentEntry: TaskEntry | null = null;

  for (const row of rows) {
    if (currentGroup === null || currentGroup.path !== row.path) {
      currentGroup = { path: row.path, entries: [] };
      groups.push(currentGroup);
      currentEntry = null;
    }
    if (row.indent === 0) {
      currentEntry = { row, children: [] };
      currentGroup.entries.push(currentEntry);
    } else {
      // indent > 0 → 直前の親 (currentEntry) の子として追加
      if (currentEntry !== null) {
        currentEntry.children.push(row);
      } else {
        // 孤立した子行は単独エントリとして扱う
        currentGroup.entries.push({ row, children: [] });
      }
    }
  }

  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'dv-task-group';
    const src = document.createElement('div');
    src.className = 'dv-task-src';
    src.append(icon(NOTE_ICON, 'dv-ico'), document.createTextNode(titleOf(group.path)));
    groupEl.append(src);

    for (const entry of group.entries) {
      const hasChildren = entry.children.length > 0;
      const wrapEl = document.createElement('div');
      wrapEl.className = 'dv-task-popover-wrap';

      // --- 親タスク行 ---
      const taskEl = document.createElement('div');
      taskEl.setAttribute('role', 'button');
      taskEl.setAttribute('tabindex', '0');
      taskEl.className = 'dv-task';
      taskEl.setAttribute('data-testid', 'dv-task');
      taskEl.setAttribute('data-path', entry.row.path);
      taskEl.setAttribute('data-line', String(entry.row.line));
      taskEl.setAttribute('aria-label', entry.row.text);

      // 展開スロット
      const toggleSlot = document.createElement('span');
      toggleSlot.className = 'dv-toggle-slot';
      toggleSlot.setAttribute('data-testid', 'dv-toggle-slot');
      if (hasChildren) {
        const expandBtn = document.createElement('span');
        expandBtn.className = 'dv-task-expand';
        expandBtn.setAttribute('data-testid', 'dv-task-expand');
        expandBtn.setAttribute('data-expanded', 'false');
        expandBtn.setAttribute('role', 'button');
        expandBtn.setAttribute('tabindex', '0');
        expandBtn.setAttribute('aria-label', '子タスクを展開');
        expandBtn.textContent = '▶';
        toggleSlot.append(expandBtn);
      }
      taskEl.append(toggleSlot);

      // 丸チェックボックス
      const cbEl = document.createElement('span');
      cbEl.className = 'task-checkbox';
      cbEl.setAttribute('data-testid', 'task-checkbox');
      cbEl.setAttribute('data-done', entry.row.checked ? 'true' : 'false');
      cbEl.setAttribute('role', 'checkbox');
      cbEl.setAttribute('aria-checked', entry.row.checked ? 'true' : 'false');
      cbEl.setAttribute('aria-label', entry.row.checked ? '完了済み' : '完了にする');
      cbEl.innerHTML = CHECK_ICON;
      taskEl.append(cbEl);

      // テキスト
      const textEl = document.createElement('span');
      textEl.className = entry.row.checked ? 'task-text task-done' : 'task-text';
      textEl.textContent = entry.row.text;
      taskEl.append(textEl);

      // ピル (フィールドあるときのみ)
      if (entry.row.status !== null) taskEl.append(makeStatusPill(entry.row.status, vocab));
      if (entry.row.due !== null) taskEl.append(makeDueChip(entry.row.due));
      if (entry.row.priority !== null) taskEl.append(makePriorityFlag(entry.row.priority, vocab));

      // 子の件数バッジ (折りたたみ時)
      let childCountBadge: HTMLElement | null = null;
      if (hasChildren) {
        childCountBadge = document.createElement('span');
        childCountBadge.className = 'dv-child-count';
        childCountBadge.textContent = `子 ${String(entry.children.length)}件`;
        taskEl.append(childCountBadge);
      }

      // 編集ボタン
      const editBtn = document.createElement('span');
      editBtn.className = 'dv-task-edit';
      editBtn.setAttribute('data-testid', 'dv-task-edit');
      editBtn.setAttribute('role', 'button');
      editBtn.setAttribute('tabindex', '0');
      editBtn.setAttribute('title', 'ステータス・期限・優先度を編集');
      editBtn.setAttribute('aria-label', 'タスクを編集');
      editBtn.innerHTML = EDIT_SVG;
      taskEl.append(editBtn);

      wrapEl.append(taskEl);

      // --- 子コンテナ ---
      let childrenEl: HTMLElement | null = null;
      if (hasChildren) {
        childrenEl = document.createElement('div');
        childrenEl.className = 'dv-children';
        childrenEl.setAttribute('data-expanded', 'false');
        childrenEl.setAttribute('data-testid', 'dv-task-children');

        for (const child of entry.children) {
          const childEl = document.createElement('div');
          childEl.setAttribute('role', 'button');
          childEl.setAttribute('tabindex', '0');
          childEl.className = 'dv-task-child';
          childEl.setAttribute('data-testid', 'dv-task-child');
          childEl.setAttribute('data-path', child.path);
          childEl.setAttribute('data-line', String(child.line));
          childEl.setAttribute('aria-label', child.text);

          const childCb = document.createElement('span');
          childCb.className = 'task-checkbox';
          childCb.setAttribute('data-testid', 'task-checkbox');
          childCb.setAttribute('data-done', child.checked ? 'true' : 'false');
          childCb.setAttribute('role', 'checkbox');
          childCb.setAttribute('aria-checked', child.checked ? 'true' : 'false');
          childCb.setAttribute('aria-label', child.checked ? '完了済み' : '完了にする');
          childCb.innerHTML = CHECK_ICON;

          const childText = document.createElement('span');
          childText.className = child.checked ? 'task-text task-done' : 'task-text';
          childText.textContent = child.text;
          childEl.append(childCb, childText);

          if (child.status !== null) childEl.append(makeStatusPill(child.status, vocab));
          if (child.due !== null) childEl.append(makeDueChip(child.due));
          if (child.priority !== null) childEl.append(makePriorityFlag(child.priority, vocab));

          const childEditBtn = document.createElement('span');
          childEditBtn.className = 'dv-task-edit';
          childEditBtn.setAttribute('data-testid', 'dv-task-edit');
          childEditBtn.setAttribute('role', 'button');
          childEditBtn.setAttribute('tabindex', '0');
          childEditBtn.setAttribute('title', '編集');
          childEditBtn.innerHTML = EDIT_SVG;
          childEl.append(childEditBtn);

          // 子行クリック → ナビゲーション (チェックボックス/編集ボタン以外)
          wireNavigation(childEl, () => {
            if (ctx.env?.openNoteAtLine !== undefined) {
              ctx.env.openNoteAtLine(child.path, child.line);
            } else {
              ctx.env?.openNote(child.path);
            }
          });

          // 子行チェックボックス toggle
          const childRow = child;
          childCb.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const oldLine = buildOldLine(childRow);
            const newChecked = !childRow.checked;
            const newLine = buildNewLine(childRow, newChecked, childRow.status, childRow.priority, childRow.due);
            void patchRowWithFeedback(childRow.path, oldLine, newLine, childEl, vocab);
          });

          // 子行編集ボタン
          const childRowRef = child;
          childEditBtn.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation();
            togglePopover(childEl, childRowRef, vocab);
          });

          childrenEl.append(childEl);
        }
        wrapEl.append(childrenEl);
      }

      // --- イベント配線 ---

      // 展開トグル
      if (hasChildren && childrenEl !== null) {
        const expandBtn = toggleSlot.querySelector('.dv-task-expand') as HTMLElement | null;
        if (expandBtn !== null) {
          expandBtn.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const expanded = childrenEl.getAttribute('data-expanded') === 'true';
            const newVal = expanded ? 'false' : 'true';
            childrenEl.setAttribute('data-expanded', newVal);
            expandBtn.setAttribute('data-expanded', newVal);
            expandBtn.textContent = expanded ? '▶' : '▼';
            if (childCountBadge !== null) {
              childCountBadge.style.display = expanded ? '' : 'none';
            }
          });
        }
      }

      // 親タスク行クリック → ナビゲーション (チェックボックス/編集ボタン/展開ボタン以外)
      wireNavigation(taskEl, () => {
        if (ctx.env?.openNoteAtLine !== undefined) {
          ctx.env.openNoteAtLine(entry.row.path, entry.row.line);
        } else {
          ctx.env?.openNote(entry.row.path);
        }
      });

      // 親チェックボックス toggle
      const parentRow = entry.row;
      cbEl.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const oldLine = buildOldLine(parentRow);
        const newChecked = !parentRow.checked;
        const newLine = buildNewLine(parentRow, newChecked, parentRow.status, parentRow.priority, parentRow.due);
        void patchRowWithFeedback(parentRow.path, oldLine, newLine, taskEl, vocab);
      });

      // 編集ボタン
      const entryRowRef = entry.row;
      editBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        togglePopover(wrapEl, entryRowRef, vocab);
      });

      groupEl.append(wrapEl);
    }

    wrap.append(groupEl);
  }
  return wrap;
}

/** `- [ ] text [status:: x] [priority:: y] [due:: z]` を再構築する (patchNote 用)。 */
function buildOldLine(row: TaskQueryRow): string {
  const indent = ' '.repeat(row.indent);
  const mark = row.checked ? '[x]' : '[ ]';
  let line = `${indent}- ${mark} ${row.text}`;
  if (row.status !== null) line = setInlineField(line, 'status', row.status);
  if (row.priority !== null) line = setInlineField(line, 'priority', row.priority);
  if (row.due !== null) line = setInlineField(line, 'due', row.due);
  return line;
}

function buildNewLine(
  row: TaskQueryRow,
  checked: boolean,
  status: string | null,
  priority: string | null,
  due: string | null,
): string {
  const indent = ' '.repeat(row.indent);
  const mark = checked ? '[x]' : '[ ]';
  let line = `${indent}- ${mark} ${row.text}`;
  if (status !== null) line = setInlineField(line, 'status', status);
  if (priority !== null) line = setInlineField(line, 'priority', priority);
  if (due !== null) line = setInlineField(line, 'due', due);
  return line;
}

/** patchNote を呼び、409 はインラインエラー表示。成功時は行の状態を更新。 */
async function patchRowWithFeedback(
  path: string,
  oldLine: string,
  newLine: string,
  rowEl: HTMLElement,
  _vocab: TaskVocabRequired,
): Promise<void> {
  // 既存の patch-error があれば除去
  rowEl.parentElement?.querySelector('.dv-patch-error')?.remove();
  try {
    await api.patchNote(path, oldLine, newLine);
  } catch (err: unknown) {
    const msg =
      err instanceof ApiError && err.status === 409
        ? '変更が競合しました (409)。リロードしてください。'
        : `書き込みエラー: ${err instanceof Error ? err.message : String(err)}`;
    const errEl = document.createElement('div');
    errEl.className = 'dv-patch-error';
    errEl.setAttribute('data-testid', 'dv-patch-error');
    errEl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.5l6 11H2z"/><path d="M8 6.5v3M8 11h.01"/></svg>';
    errEl.append(document.createTextNode(msg));
    rowEl.after(errEl);
  }
}

/** popover のトグル (既に開いていれば閉じる) */
function togglePopover(
  wrapEl: HTMLElement,
  row: TaskQueryRow,
  vocab: TaskVocabRequired,
): void {
  const existing = wrapEl.querySelector('.dv-task-popover');
  if (existing !== null) { existing.remove(); return; }
  const pop = buildDvPopover({
    row,
    vocab,
    onApply: async (status, priority, due) => {
      const oldLine = buildOldLine(row);
      const newLine = buildNewLine(row, row.checked, status, priority, due);
      pop.remove();
      await patchRowWithFeedback(row.path, oldLine, newLine, wrapEl, vocab);
    },
    onClose: () => { pop.remove(); },
  });
  wrapEl.append(pop);
}

/** 構文エラー表示 (prototype の dv-error — クエリ行 + キャレット + 位置情報)。 */
function renderQueryError(code: string, err: QueryApiError): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'dv-error';
  pre.setAttribute('data-testid', 'dataview-error');
  const srcLine = code.split('\n')[err.line - 1] ?? '';
  const caret = ' '.repeat(Math.max(0, err.column - 1)) + '^'.repeat(Math.max(1, err.length));
  pre.textContent = `クエリを解析できません (${String(err.status)})\n\n  ${srcLine}\n  ${caret}\n${err.message}`;
  return pre;
}

function renderPlainError(message: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'dv-error';
  pre.setAttribute('data-testid', 'dataview-error');
  pre.textContent = message;
  return pre;
}

// ---- レンダラー本体 ---------------------------------------------------------------

interface RenderOutcome {
  /** 結果の同一性キー (変わったときだけ再描画する) */
  signature: string;
  queryType: 'list' | 'table' | 'task' | 'error';
  build: () => HTMLElement;
}

async function runOnce(code: string, ctx: RenderContext, vocab: TaskVocabRequired): Promise<RenderOutcome> {
  const query = code.trim();
  try {
    const res: QueryResponse = await api.query(query);
    const signature = JSON.stringify(res);
    if (res.type === 'list') {
      return { signature, queryType: 'list', build: () => renderList(res.results, ctx) };
    }
    if (res.type === 'table') {
      return { signature, queryType: 'table', build: () => renderTable(res.fields, res.results, ctx) };
    }
    return { signature, queryType: 'task', build: () => renderTasks(res.results, ctx, vocab) };
  } catch (err: unknown) {
    if (err instanceof QueryApiError) {
      return {
        signature: `error:${err.message}`,
        queryType: 'error',
        build: () => renderQueryError(query, err),
      };
    }
    const message =
      err instanceof ApiError
        ? `クエリを実行できませんでした (${String(err.status)}) — ${err.message}`
        : `クエリを実行できませんでした — ${err instanceof Error ? err.message : String(err)}`;
    return { signature: `error:${message}`, queryType: 'error', build: () => renderPlainError(message) };
  }
}

/** el へ結果を描画し、DOM が生きている間はファイル変更に追従して更新し続ける。 */
async function renderDataview(code: string, el: HTMLElement, ctx: RenderContext): Promise<void> {
  el.classList.add('dv-body');
  el.setAttribute('data-testid', 'dataview-widget');

  // タスク語彙を取得 (TASK クエリのみ使用。失敗時は DEFAULT_TASK_VOCAB にフォールバック)。
  let vocab: TaskVocabRequired = DEFAULT_TASK_VOCAB;
  try {
    vocab = await api.getTaskVocab();
  } catch {
    // 設定取得失敗時は DEFAULT_TASK_VOCAB で動く
  }

  const apply = (outcome: RenderOutcome): void => {
    el.setAttribute('data-query-type', outcome.queryType);
    el.replaceChildren(outcome.build());
  };
  const first = await runOnce(code, ctx, vocab);
  apply(first);

  // ファイル変更追従 (AC-Sb1593c-2-2): widget の DOM が document から外れたら止める。
  // push 通知基盤 (SSE 等) は無いのでポーリング + 結果差分のみ再描画 (decisions I 参照)
  let last = first.signature;
  let running = false;
  const timer = window.setInterval(() => {
    if (!el.isConnected) {
      window.clearInterval(timer);
      return;
    }
    if (running) return; // 前回の実行が終わっていなければスキップ (デバウンス)
    running = true;
    void runOnce(code, ctx, vocab)
      .then((outcome) => {
        if (!el.isConnected || outcome.signature === last) return;
        last = outcome.signature;
        apply(outcome);
      })
      .finally(() => {
        running = false;
      });
  }, DATAVIEW_REFRESH_MS);
}

/** dataview フェンスレンダラーを登録する (renderers/index.ts から呼ぶ)。 */
export function registerDataviewRenderer(): void {
  registerFenceRenderer({
    lang: 'dataview',
    kind: 'client',
    mode: 'replace',
    info: 'クリックでソース編集',
    render(code, el, ctx) {
      return renderDataview(code, el, ctx);
    },
  });
}
