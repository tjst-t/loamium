/**
 * Story Sd40b63-1「テーブルの WYSIWYG 編集」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 *
 * 「セル編集 → 保存 → ファイル内容が標準 Markdown テーブル」を実ファイル読取で検証し、
 * ピュア Markdown 正本性 (DESIGN_PRINCIPLES priority 1) を担保する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openNoteFromTree(page: Page, rel: string, waitText: string): Promise<void> {
  await page.goto(state().uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

/** ソースに不可視/制御文字を混入させないため、検出用パターンは全て escape で表す。 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF\u00A0]/; // zero-width / NBSP
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // control chars (excl tab/lf/cr)

test('[AC-Sd40b63-1-1] 描画テーブルのセルを直接編集でき、外すと表として再描画・標準 Markdown に反映', async ({
  page,
}) => {
  const source = 'table/wysiwyg-edit.md';
  await putNote(
    source,
    ['# 編集', '', '| 名前 | 数 |', '| --- | --- |', '| りんご | 12 |', '', 'アンカー行。', ''].join(
      '\n',
    ),
  );
  await openNoteFromTree(page, source, 'アンカー行');

  // カーソルをテーブル外へ → HTML テーブル描画
  await editorLine(page, 'アンカー行').click();
  const table = page.getByTestId('table-widget');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr').first().locator('td').first()).toHaveText('りんご');

  // 先頭データセルをクリック → 編集 input が開き、現在値が見える
  await table.locator('tbody tr').first().locator('td').first().locator('.cell-body').click();
  const input = page.getByTestId('table-cell-input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('りんご');

  // 内容を書き換える (全選択 → 入力)
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ばなな');

  // フォーカスをテーブル外へ → コミットされ、表として再描画される
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('table-cell-input')).toHaveCount(0);
  await expect(
    page.getByTestId('table-widget').locator('tbody tr').first().locator('td').first(),
  ).toHaveText('ばなな');

  // 保存 → ファイルは標準 Markdown テーブルとして更新される
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile(source);
  expect(file).toContain('| ばなな | 12 |');
  expect(file).toContain('| 名前 | 数 |');
  expect(file).toContain('| --- | --- |');
  expect(file).not.toContain('りんご');
});

test('[AC-Sd40b63-1-2] 行・列を追加/削除でき、結果は標準 Markdown テーブルとして保存される', async ({
  page,
}) => {
  const source = 'table/wysiwyg-structure.md';
  await putNote(
    source,
    ['# 構造', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '終わり。', ''].join('\n'),
  );
  await openNoteFromTree(page, source, '終わり。');

  await editorLine(page, '終わり。').click();
  const table = page.getByTestId('table-widget');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveCount(2);
  await expect(table.locator('tbody tr')).toHaveCount(1);

  // 行を追加 → データ行 2 行
  await page.getByTestId('table-add-row').click();
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(2);

  // 列を追加 → 3 列
  await page.getByTestId('table-add-col').click();
  await expect(page.getByTestId('table-widget').locator('thead th')).toHaveCount(3);

  // 先頭データ行を削除 → 1 行
  await page.locator('[data-testid="table-del-row"][data-row="0"]').click();
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(1);

  // 先頭列 (A) を削除 → 2 列
  await page.locator('[data-testid="table-del-col"][data-col="0"]').click();
  await expect(page.getByTestId('table-widget').locator('thead th')).toHaveCount(2);

  // 保存 → 標準 Markdown テーブル (ヘッダ + 区切り + データ行) として保存される
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile(source);
  const tableLines = file.split('\n').filter((l) => l.trim().startsWith('|'));
  // ヘッダ(B と空列) + 区切り + データ 1 行 = 3 行、全て標準 | 記法
  expect(tableLines).toEqual(['| B |  |', '| --- | --- |', '|  |  |']);
  expect(file).not.toContain('| A |'); // 削除した列は残らない
  expect(file).not.toContain('| 1 |'); // 削除した行は残らない
});

test('[AC-Sd40b63-1-3] WYSIWYG 編集後もファイルはピュア Markdown (パイプは \\| エスケープ、不可視文字なし)', async ({
  page,
}) => {
  const source = 'table/wysiwyg-pure.md';
  await putNote(
    source,
    ['# ピュア', '', '| 式 | 説明 |', '| --- | --- |', '|  | 論理和 |', '', 'アンカー行。', ''].join(
      '\n',
    ),
  );
  await openNoteFromTree(page, source, 'アンカー行');

  await editorLine(page, 'アンカー行').click();
  const table = page.getByTestId('table-widget');
  await expect(table).toBeVisible();

  // 空セル (式 列) にパイプを含むテキストを入力する
  await table.locator('tbody tr').first().locator('td').first().locator('.cell-body').click();
  await expect(page.getByTestId('table-cell-input')).toBeVisible();
  await page.keyboard.type('a|b');
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('table-cell-input')).toHaveCount(0);

  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile(source);

  // パイプは \| でエスケープされ、標準 Markdown テーブルのまま
  expect(file).toContain('| a\\|b | 論理和 |');
  expect(file).toContain('| --- | --- |');
  // 独自記法・ブロック ID・不可視文字が一切混入していない (Obsidian で壊れない)
  expect(file).not.toMatch(/\^[A-Za-z0-9]{6}/); // ^blockid
  expect(file).not.toContain('id::');
  expect(ZERO_WIDTH_RE.test(file)).toBe(false);
  expect(CONTROL_RE.test(file)).toBe(false);
});
