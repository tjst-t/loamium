/**
 * GFM テーブルのライブプレビュー描画 + WYSIWYG 編集 (S79c210-2 → Sd40b63-1)。
 *
 * ヘッダ行 + 区切り行 (| --- | :--: |) + データ行から成る標準 Markdown テーブルを
 * HTML <table> として表示する。正本は | 記法のまま (表示層のみ — DESIGN_PRINCIPLES
 * priority 1)。handlers を渡すと各セルを直接編集でき、行/列の追加・削除ができる。
 * 編集結果は必ず「標準 Markdown テーブル文字列」へ直列化して handlers.commit に渡す
 * (ブロック ID・独自記法・不可視文字を一切混入しない — priority 1 / 4)。
 *
 * セル内のインライン記法 (`code` / **bold** / [[link]] 等) は mini-md の
 * appendInlineMarkdown を再利用して描画する。編集中のセルだけ生ソース (input) を見せ、
 * フォーカスを外すと再びレンダリング表示へ戻る (Live Preview のソース⇄描画と同じ思想)。
 */
import { appendInlineMarkdown } from './mini-md.js';

type Align = 'left' | 'center' | 'right' | null;

/** 編集結果を元ドキュメントへ書き戻すためのハンドラ (エディタ側が dispatch を担う)。 */
export interface TableEditHandlers {
  /** 変更後の標準 Markdown テーブル (\n 区切りの複数行文字列) をコミットする。 */
  commit(newSource: string): void;
}

/** テーブルの編集モデル。セル文字列はすべて「編集用 (パイプ非エスケープ)」形式で保持する。 */
export interface TableModel {
  header: string[];
  aligns: Align[];
  rows: string[][];
}

/**
 * GFM テーブルの 1 行を セル配列へ分解する。前後のパイプは剥がし、
 * バックスラッシュでエスケープした \| はセル区切りにしない。
 */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 区切り行のセル (:---: 等) から列の揃えを判定する。 */
function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** 揃えを区切り行セルへ戻す。 */
function delimOf(align: Align): string {
  switch (align) {
    case 'left':
      return ':---';
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    default:
      return '---';
  }
}

/** バックスラッシュエスケープ (\| → |) を表示テキストへ戻す。 */
function unescapeCell(text: string): string {
  return text.replace(/\\([|\\`*_~])/g, '$1');
}

/**
 * ソースセル → 編集用テキスト。パイプのエスケープ (\|) だけを解除する。
 * 他のバックスラッシュ列 (\\ / \` 等) は一切触らない → 直列化と完全な逆変換になり、
 * 未編集セルを勝手に書き換えない (Obsidian で開いて壊れない — priority 1)。
 */
export function toEditable(src: string): string {
  return src.replace(/\\\|/g, '|');
}

/**
 * 編集用テキスト → ソースセル。パイプだけを \| へエスケープし、改行は空白へ潰す
 * (セル内改行は扱わない仕様)。最小限のエスケープに留める (整形しすぎない)。
 */
export function toSource(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

/** テーブルのソース行配列を編集モデルへ分解する。lines[0]=ヘッダ, [1]=区切り, [2..]=データ。 */
export function parseTableModel(lines: string[]): TableModel {
  const header = splitTableRow(lines[0] ?? '').map(toEditable);
  const ncol = Math.max(1, header.length);
  while (header.length < ncol) header.push('');
  const rawAligns = splitTableRow(lines[1] ?? '').map(alignOf);
  const aligns: Align[] = [];
  for (let c = 0; c < ncol; c++) aligns.push(rawAligns[c] ?? null);
  const rows: string[][] = [];
  for (let r = 2; r < lines.length; r++) {
    const text = lines[r] ?? '';
    if (text.trim() === '') continue;
    const cells = splitTableRow(text).map(toEditable);
    const row: string[] = [];
    for (let c = 0; c < ncol; c++) row.push(cells[c] ?? '');
    rows.push(row);
  }
  return { header, aligns, rows };
}

/** 1 行分のセル配列を標準 Markdown 行へ直列化する (列幅パディングは最小)。 */
function serializeRow(cells: string[], ncol: number): string {
  const out: string[] = [];
  for (let c = 0; c < ncol; c++) out.push(toSource(cells[c] ?? ''));
  return `| ${out.join(' | ')} |`;
}

/** 編集モデルを標準 Markdown テーブル (ヘッダ + 区切り + データ行) へ直列化する。 */
export function serializeTableModel(model: TableModel): string {
  const ncol = Math.max(1, model.header.length);
  const lines: string[] = [];
  lines.push(serializeRow(model.header, ncol));
  const delim: string[] = [];
  for (let c = 0; c < ncol; c++) delim.push(delimOf(model.aligns[c] ?? null));
  lines.push(`| ${delim.join(' | ')} |`);
  for (const row of model.rows) lines.push(serializeRow(row, ncol));
  return lines.join('\n');
}

// ---- 純粋な行/列操作 (ユニットテスト対象) -----------------------------------

/** 末尾に空行を追加する。 */
export function addRow(model: TableModel): void {
  model.rows.push(new Array<string>(Math.max(1, model.header.length)).fill(''));
}

/** 末尾に空列を追加する (ヘッダ・区切り・全データ行に列を足す)。 */
export function addColumn(model: TableModel): void {
  model.header.push('');
  model.aligns.push(null);
  for (const row of model.rows) row.push('');
}

/** 指定位置のデータ行を削除する。 */
export function deleteRow(model: TableModel, index: number): void {
  if (index >= 0 && index < model.rows.length) model.rows.splice(index, 1);
}

/** 指定位置の列を削除する (列は最低 1 列残す)。 */
export function deleteColumn(model: TableModel, index: number): void {
  if (model.header.length <= 1) return;
  if (index < 0 || index >= model.header.length) return;
  model.header.splice(index, 1);
  model.aligns.splice(index, 1);
  for (const row of model.rows) row.splice(index, 1);
}

// ---- SVG アイコン ------------------------------------------------------------

const ICON_TIMES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';

// ---- 描画 -------------------------------------------------------------------

/**
 * テーブルのソース行配列を <table> 要素へ描画する。
 * handlers を渡すとセル編集・行/列操作が有効になる (エディタ内)。
 * 省略時は読み取り専用 (ユニットテスト等)。
 */
export function renderMarkdownTable(lines: string[], handlers?: TableEditHandlers): HTMLElement {
  const model = parseTableModel(lines);
  const editable = handlers !== undefined;

  const wrap = document.createElement('div');
  wrap.className = editable ? 'md-table-wrap editable' : 'md-table-wrap';
  wrap.setAttribute('data-testid', 'table-widget');
  if (editable) wrap.setAttribute('data-editable', 'true');

  const main = document.createElement('div');
  main.className = 'md-table-main';

  const table = document.createElement('table');
  table.className = 'md-table';

  const ncol = () => Math.max(1, model.header.length);

  // 最後にコミットした直列化結果 (二重 dispatch 防止)
  let lastCommitted = serializeTableModel(model);
  // 編集中セルの現在値をモデルへ反映するフラッシュ関数 (編集中のみ非 null)。
  // focusout が input の blur より先に発火する場合があるため、コミット前に必ず呼ぶ。
  let flushActive: (() => void) | null = null;

  const structuralCommit = (): void => {
    if (handlers === undefined) return;
    if (flushActive !== null) flushActive();
    const s = serializeTableModel(model);
    lastCommitted = s;
    handlers.commit(s);
  };
  const commitFinal = (): void => {
    if (handlers === undefined) return;
    if (flushActive !== null) flushActive();
    const s = serializeTableModel(model);
    if (s !== lastCommitted) {
      lastCommitted = s;
      handlers.commit(s);
    }
  };

  const getCell = (r: number, c: number): string =>
    r < 0 ? model.header[c] ?? '' : model.rows[r]?.[c] ?? '';
  const setCell = (r: number, c: number, v: string): void => {
    const val = v.replace(/[\r\n]+/g, ' ');
    if (r < 0) model.header[c] = val;
    else if (model.rows[r] !== undefined) model.rows[r][c] = val;
  };

  const renderCellBody = (span: HTMLElement, r: number, c: number): void => {
    span.replaceChildren();
    appendInlineMarkdown(span, unescapeCell(getCell(r, c)), {});
  };

  /** (r,c) の順序リスト (ヘッダ → データ行) を作り、Tab 移動に使う。 */
  const cellOrder = (): Array<[number, number]> => {
    const order: Array<[number, number]> = [];
    const n = ncol();
    for (let c = 0; c < n; c++) order.push([-1, c]);
    for (let r = 0; r < model.rows.length; r++) for (let c = 0; c < n; c++) order.push([r, c]);
    return order;
  };

  const bodyByCoord = new Map<string, HTMLElement>();
  const key = (r: number, c: number): string => `${r}:${c}`;

  const focusCell = (r: number, c: number): void => {
    const span = bodyByCoord.get(key(r, c));
    if (span !== undefined) beginEdit(span, r, c);
  };

  function beginEdit(span: HTMLElement, r: number, c: number): void {
    if (span.dataset.editing === '1') return;
    span.dataset.editing = '1';
    const cell = span.parentElement;
    if (cell === null) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'md-cell-input';
    input.setAttribute('data-testid', 'table-cell-input');
    input.value = getCell(r, c);
    span.style.display = 'none';
    cell.insertBefore(input, span);
    input.focus();
    const len = input.value.length;
    try {
      input.setSelectionRange(len, len);
    } catch {
      // 一部ブラウザで input 種別により失敗しうる。キャレット位置は無視して継続。
    }
    // focusout が blur より先に来ても編集値を失わないよう flush を登録
    flushActive = () => setCell(r, c, input.value);

    const finish = (): void => {
      if (span.dataset.editing !== '1') return;
      setCell(r, c, input.value);
      flushActive = null;
      if (input.parentElement !== null) input.parentElement.removeChild(input);
      span.style.display = '';
      renderCellBody(span, r, c);
      span.dataset.editing = '';
    };
    const cancel = (): void => {
      if (span.dataset.editing !== '1') return;
      flushActive = null;
      if (input.parentElement !== null) input.parentElement.removeChild(input);
      span.style.display = '';
      span.dataset.editing = '';
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return; // IME 変換中はブラウザに委ねる
      if (e.key === 'Enter') {
        e.preventDefault();
        finish();
        commitFinal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        setCell(r, c, input.value);
        const order = cellOrder();
        const idx = order.findIndex(([rr, cc]) => rr === r && cc === c);
        const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
        const next = order[nextIdx];
        finish();
        if (next !== undefined) focusCell(next[0], next[1]);
        else commitFinal();
      }
    });
    // beforeinput / input は CodeMirror の DOM 監視へ伝播させない (誤同期防止)
    input.addEventListener('beforeinput', (e) => e.stopPropagation());
    input.addEventListener('input', (e) => e.stopPropagation());
    // blur でモデルへ反映し、フォーカス先が同一テーブル内の別セルでなければコミットする
    // (focusout の発火順に依存せず、blur の relatedTarget で確実に判定する)。
    input.addEventListener('blur', (e) => {
      const rt = e.relatedTarget;
      const stayingInTable = rt instanceof Node && wrap.contains(rt);
      finish();
      if (!stayingInTable) commitFinal();
    });
  }

  const makeCell = (tag: 'th' | 'td', r: number, c: number): HTMLElement => {
    const el = document.createElement(tag);
    const align = model.aligns[c] ?? null;
    if (align !== null) el.style.textAlign = align;
    const span = document.createElement('span');
    span.className = 'cell-body';
    renderCellBody(span, r, c);
    el.append(span);
    if (editable) {
      bodyByCoord.set(key(r, c), span);
      // クリックで CM のキャレットを奪わずにインライン編集へ入る
      span.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        beginEdit(span, r, c);
      });
    }
    return el;
  };

  const makeColDel = (c: number): HTMLElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-col-del';
    btn.setAttribute('data-testid', 'table-del-col');
    btn.setAttribute('data-col', String(c));
    btn.title = '列を削除';
    btn.innerHTML = ICON_TIMES;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteColumn(model, c);
      structuralCommit();
    });
    return btn;
  };

  const makeRowDel = (r: number): HTMLElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-row-del';
    btn.setAttribute('data-testid', 'table-del-row');
    btn.setAttribute('data-row', String(r));
    btn.title = '行を削除';
    btn.innerHTML = ICON_TIMES;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteRow(model, r);
      structuralCommit();
    });
    return btn;
  };

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (let c = 0; c < ncol(); c++) {
    const th = makeCell('th', -1, c);
    if (editable) th.append(makeColDel(c));
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (let r = 0; r < model.rows.length; r++) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-row', String(r));
    for (let c = 0; c < ncol(); c++) {
      const td = makeCell('td', r, c);
      if (editable && c === ncol() - 1) td.append(makeRowDel(r));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  main.append(table);

  if (editable) {
    const addCol = document.createElement('button');
    addCol.type = 'button';
    addCol.className = 'md-table-add-col';
    addCol.setAttribute('data-testid', 'table-add-col');
    addCol.title = '列を追加';
    addCol.innerHTML = ICON_PLUS;
    addCol.addEventListener('mousedown', (e) => e.preventDefault());
    addCol.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addColumn(model);
      structuralCommit();
    });
    main.append(addCol);
  }

  wrap.append(main);

  if (editable) {
    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'md-table-add-row';
    addRowBtn.setAttribute('data-testid', 'table-add-row');
    addRowBtn.title = '行を追加';
    addRowBtn.innerHTML = `${ICON_PLUS}<span>行を追加</span>`;
    addRowBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addRow(model);
      structuralCommit();
    });
    wrap.append(addRowBtn);

    // フォーカスがテーブル外へ抜けたら最終コミット (セル間移動では抜けない)
    wrap.addEventListener('focusout', (e) => {
      const rt = e.relatedTarget;
      if (rt instanceof Node && wrap.contains(rt)) return;
      commitFinal();
    });
  }

  return wrap;
}
