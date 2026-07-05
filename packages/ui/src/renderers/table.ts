/**
 * GFM テーブルのライブプレビュー描画 (S79c210-2)。
 *
 * ヘッダ行 + 区切り行 (| --- | :--: |) + データ行から成る標準 Markdown テーブルを
 * HTML <table> として表示する。正本は | 記法のまま (表示層のみ — DESIGN_PRINCIPLES
 * priority 1)。テーブルの検出は live-preview.ts が lezer-markdown の Table ノードで行い、
 * ここは行テキストの配列を受け取って DOM を組み立てるだけ (innerHTML 不使用 — priority 2)。
 *
 * セル内のインライン記法 (`code` / **bold** / [[link]] 等) は mini-md の
 * appendInlineMarkdown を再利用して描画する。
 */
import { appendInlineMarkdown } from './mini-md.js';

type Align = 'left' | 'center' | 'right' | null;

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

/** バックスラッシュエスケープ (\| → |) を表示テキストへ戻す。 */
function unescapeCell(text: string): string {
  return text.replace(/\\([|\\`*_~])/g, '$1');
}

function fillCell(cell: HTMLElement, text: string, align: Align): void {
  if (align !== null) cell.style.textAlign = align;
  appendInlineMarkdown(cell, unescapeCell(text), {});
}

/**
 * テーブルのソース行配列を <table> 要素へ描画する。
 * lines[0] = ヘッダ, lines[1] = 区切り, lines[2..] = データ。
 */
export function renderMarkdownTable(lines: string[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'md-table-wrap';
  wrap.setAttribute('data-testid', 'table-widget');

  const table = document.createElement('table');
  table.className = 'md-table';

  const headerCells = splitTableRow(lines[0] ?? '');
  const aligns = splitTableRow(lines[1] ?? '').map(alignOf);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headerCells.forEach((text, i) => {
    const th = document.createElement('th');
    fillCell(th, text, aligns[i] ?? null);
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (let r = 2; r < lines.length; r++) {
    const rowText = lines[r] ?? '';
    if (rowText.trim() === '') continue;
    const cells = splitTableRow(rowText);
    const tr = document.createElement('tr');
    // 列数はヘッダに合わせる (不足は空セル、超過は切り捨て — GFM 準拠)
    for (let c = 0; c < headerCells.length; c++) {
      const td = document.createElement('td');
      fillCell(td, cells[c] ?? '', aligns[c] ?? null);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);

  wrap.append(table);
  return wrap;
}
