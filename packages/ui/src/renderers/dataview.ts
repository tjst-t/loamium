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
 */
import type { ListQueryRow, QueryResponse, TableCellValue, TaskQueryRow } from '@loamium/shared';
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

function renderCell(value: TableCellValue): HTMLElement {
  const td = document.createElement('td');
  if (value === null) {
    td.textContent = '';
  } else if (Array.isArray(value)) {
    // tags 等の文字列配列はチップ表示 (prototype の dv-tag)
    for (const v of value) {
      const chip = document.createElement('span');
      chip.className = 'dv-tag';
      chip.textContent = `#${v}`;
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
    for (const value of row.values) tr.append(renderCell(value));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function renderTasks(rows: TaskQueryRow[], ctx: RenderContext): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dv-tasks';
  // ノート別グループ (結果はサーバー側で path → 行番号順に整列済み)
  let group: HTMLElement | null = null;
  let groupPath: string | null = null;
  for (const row of rows) {
    if (group === null || groupPath !== row.path) {
      group = document.createElement('div');
      group.className = 'dv-task-group';
      groupPath = row.path;
      const src = document.createElement('div');
      src.className = 'dv-task-src';
      src.append(icon(NOTE_ICON, 'dv-ico'), document.createTextNode(titleOf(row.path)));
      group.append(src);
      wrap.append(group);
    }
    const task = document.createElement('button');
    task.type = 'button';
    task.className = 'dv-task';
    task.setAttribute('data-testid', 'dataview-task');
    task.setAttribute('data-path', row.path);
    task.setAttribute('data-line', String(row.line));
    const checkbox = document.createElement('span');
    checkbox.className = row.checked ? 'task-checkbox checked' : 'task-checkbox';
    checkbox.setAttribute('aria-label', row.checked ? '完了タスク' : '未完了タスク');
    if (row.checked) checkbox.innerHTML = CHECK_ICON;
    const text = document.createElement('span');
    if (row.checked) text.className = 'task-done';
    text.textContent = row.text;
    const lineRef = document.createElement('span');
    lineRef.className = 'line-ref';
    lineRef.textContent = `L${String(row.line)}`;
    task.append(checkbox, text, lineRef);
    const { path, line } = row;
    wireNavigation(task, () => {
      if (ctx.env?.openNoteAtLine !== undefined) {
        ctx.env.openNoteAtLine(path, line);
      } else {
        ctx.env?.openNote(path);
      }
    });
    group.append(task);
  }
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dv-empty';
    empty.textContent = '0 件';
    wrap.append(empty);
  }
  return wrap;
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

async function runOnce(code: string, ctx: RenderContext): Promise<RenderOutcome> {
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
    return { signature, queryType: 'task', build: () => renderTasks(res.results, ctx) };
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
  const apply = (outcome: RenderOutcome): void => {
    el.setAttribute('data-query-type', outcome.queryType);
    el.replaceChildren(outcome.build());
  };
  const first = await runOnce(code, ctx);
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
    void runOnce(code, ctx)
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
