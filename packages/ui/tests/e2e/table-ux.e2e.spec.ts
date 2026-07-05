/**
 * Story Sa629e2-1「テーブル WYSIWYG の UX 仕上げ」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * 保存後の実ファイル読取で「標準 Markdown テーブルのまま」を検証する (priority 1)。
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

test('[AC-Sa629e2-1-1] 行/列追加コントロールがテーブルの幅/高さに収まって表示される (エディタ幅にはみ出さない)', async ({
  page,
}) => {
  const source = 'table/ux-layout.md';
  await putNote(
    source,
    ['# レイアウト', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'アンカー行。', ''].join('\n'),
  );
  await openNoteFromTree(page, source, 'アンカー行');
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('table-widget');
  await expect(widget).toBeVisible();
  await widget.hover();

  const tableBox = await widget.locator('table.md-table').boundingBox();
  const addRowBox = await page.getByTestId('table-add-row').boundingBox();
  const addColBox = await page.getByTestId('table-add-col').boundingBox();
  const editorBox = await page.getByTestId('editor').boundingBox();
  if (tableBox === null || addRowBox === null || addColBox === null || editorBox === null) {
    throw new Error('bounding box が取得できませんでした');
  }
  // 行追加バー: テーブル幅に収まり、エディタ幅いっぱいに伸びない
  expect(addRowBox.width).toBeLessThanOrEqual(tableBox.width + 4);
  expect(addRowBox.width).toBeLessThan(editorBox.width * 0.8);
  // 列追加バー: テーブル高さに収まり、テーブルの右外へはみ出しすぎない
  expect(addColBox.height).toBeLessThanOrEqual(tableBox.height + 4);
  expect(addColBox.x).toBeLessThan(tableBox.x + tableBox.width + 24);
  // 追加後もクリック操作は可能 (ホバー表示は視覚のみ)
  await page.getByTestId('table-add-row').click();
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(2);
});

test('[AC-Sa629e2-1-2] セル (パディング領域含む) を 1 クリックで確実に編集状態になり、即入力できる', async ({
  page,
}) => {
  const source = 'table/ux-click.md';
  await putNote(
    source,
    ['# クリック', '', '| 品目 | 値 |', '| --- | --- |', '| りんご | 12 |', '', 'アンカー行。', ''].join(
      '\n',
    ),
  );
  await openNoteFromTree(page, source, 'アンカー行');
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('table-widget');
  await expect(widget).toBeVisible();

  // 先頭列セルのパディング領域 (テキスト外・右端近く) を 1 クリック
  const td = widget.locator('tbody tr').first().locator('td').first();
  const box = await td.boundingBox();
  if (box === null) throw new Error('td の bounding box が取得できませんでした');
  await td.click({ position: { x: box.width - 3, y: box.height / 2 } });

  // 1 クリックで input にフォーカスが入り、追加操作なしで即入力できる
  const input = page.getByTestId('table-cell-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('りんご');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('もも');

  // コミットして保存 → 実ファイルに反映されている
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile(source);
  expect(file).toContain('| もも | 12 |');
});

test('[AC-Sa629e2-1-3] Tab/Shift+Tab/Enter で Excel 風にセル移動でき、最終セルの Tab は行を追加する', async ({
  page,
}) => {
  const source = 'table/ux-nav.md';
  await putNote(
    source,
    ['# ナビ', '', '| A | B |', '| --- | --- |', '| a1 | b1 |', '| a2 | b2 |', '', 'アンカー行。', ''].join(
      '\n',
    ),
  );
  await openNoteFromTree(page, source, 'アンカー行');
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('table-widget');
  await widget.locator('tbody tr').first().locator('td').first().locator('.cell-body').click();
  const input = page.getByTestId('table-cell-input');
  await expect(input).toHaveValue('a1');

  // 値を書き換えて Tab → コミットしてから右のセルへ移動
  await page.keyboard.press('Control+a');
  await page.keyboard.type('A1改');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('b1');
  await expect(
    page.getByTestId('table-widget').locator('tbody tr').first().locator('td').first(),
  ).toHaveText('A1改');

  // 行末セルで Tab → 次行の先頭セルへ
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('a2');

  // Shift+Tab → 左 (前) のセルへ戻る
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('b1');

  // Enter → 下のセルへ
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('b2');

  // 最終セルへ移動して Tab → 行が追加され、新行の先頭セルの編集が始まる
  await page.keyboard.press('Control+a');
  await page.keyboard.type('B2改');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(3);
  const newInput = page.getByTestId('table-cell-input');
  await expect(newInput).toBeVisible();
  await expect(newInput).toBeFocused();
  await page.keyboard.type('a3');
  await page.keyboard.press('Enter');

  // 保存 → 実ファイルは標準 Markdown テーブルとして更新されている
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile(source);
  expect(file).toContain('| A1改 | b1 |');
  expect(file).toContain('| a2 | B2改 |');
  expect(file).toContain('| a3 |  |'); // 最終セル Tab で追加された行
  expect(file).toContain('| --- | --- |');
});

test('[AC-Sa629e2-1-4] 『ソースを編集』でテーブル行のソース表示へ明示切替でき、カーソルがテーブルに入る', async ({
  page,
}) => {
  const source = 'table/ux-source.md';
  await putNote(
    source,
    ['# ソース', '', '| 名前 | 数 |', '| --- | --- |', '| りんご | 12 |', '', 'アンカー行。', ''].join(
      '\n',
    ),
  );
  await openNoteFromTree(page, source, 'アンカー行');
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('table-widget');
  await expect(widget).toBeVisible();
  await widget.hover();
  const btn = page.getByTestId('table-edit-source');
  await expect(btn).toBeVisible();
  await btn.click();

  // widget が外れてソース (| 記法) が表示され、カーソルがテーブル行に入っている
  await expect(page.getByTestId('table-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('| 名前 | 数 |');
  await expect(page.locator('[data-testid="editor"] .cm-activeLine')).toContainText('| 名前 | 数 |');

  // ソースとして直接編集できる (エディタにフォーカスがある)
  await page.keyboard.press('End');
  await page.keyboard.type(' 個数 |');
  await expect(page.getByTestId('editor')).toContainText('| 名前 | 数 | 個数 |');

  // ファイルはピュア Markdown のまま
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile(source);
  expect(file).toContain('| 名前 | 数 | 個数 |');
  expect(file).not.toMatch(/\^[A-Za-z0-9]{6}/);
  expect(file).not.toContain('id::');
});
