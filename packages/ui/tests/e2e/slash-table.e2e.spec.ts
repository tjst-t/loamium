/**
 * Story Sd40b63-2「スラッシュメニューのテーブルサイズ指定 + スクロール追従」E2E。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
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

test('[AC-Sd40b63-2-1] テーブルを選ぶとグリッドピッカーが出て、選んだサイズの標準 Markdown テーブルが挿入される', async ({
  page,
}) => {
  const source = 'slash-table-size.md';
  await putNote(source, '# サイズ\n\nアンカー行。\n');
  await openNoteFromTree(page, source, 'アンカー行');

  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/table');
  await expect(page.getByTestId('slash-menu')).toBeVisible();

  // table を選ぶ → グリッドピッカー (既定 3×3)
  await page.keyboard.press('Enter');
  const picker = page.getByTestId('slash-table-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('slash-table-picker-label')).toHaveText('3 列 × 3 行');

  // キーで 4 列 × 2 行 に変更 (→ で列+1、↑ で行-1)
  await page.keyboard.press('ArrowRight'); // 4 列
  await page.keyboard.press('ArrowUp'); // 2 行
  await expect(page.getByTestId('slash-table-picker-label')).toHaveText('4 列 × 2 行');

  // Enter で確定挿入。カーソルは先頭セル (そのまま打つと先頭セルに入る)
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  await page.keyboard.type('X');
  await expect(editorLine(page, 'X見出し1')).toContainText(
    '| X見出し1 | 見出し2 | 見出し3 | 見出し4 |',
  );

  // 保存 → 4 列 × (ヘッダ + 区切り + 2 データ行) の標準 Markdown テーブル
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readFile(path.join(state().vault, source), 'utf8');
  const tableLines = file.split('\n').filter((l) => l.trim().startsWith('|'));
  expect(tableLines).toEqual([
    '| X見出し1 | 見出し2 | 見出し3 | 見出し4 |',
    '| --- | --- | --- | --- |',
    '|  |  |  |  |',
    '|  |  |  |  |',
  ]);
});

test('[AC-Sd40b63-2-2] ↑↓ のキーボード選択でアクティブ項目が常に表示範囲に入る (スクロール追従)', async ({
  page,
}) => {
  const source = 'slash-scroll.md';
  await putNote(source, '# スクロール\n\nアンカー行。\n');
  await openNoteFromTree(page, source, 'アンカー行');

  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await expect(page.getByTestId('slash-item')).toHaveCount(9);

  const list = page.locator('.slash-list');
  const lastItem = page.locator('[data-testid="slash-item"][data-command="date"]');
  const firstItem = page.locator('[data-testid="slash-item"][data-command="table"]');

  /** 選択項目がリストの表示範囲に完全に収まっているか (スクロール settle まで poll)。 */
  const inViewport = async (item: typeof lastItem): Promise<boolean> => {
    const lb = await list.boundingBox();
    const ib = await item.boundingBox();
    if (lb === null || ib === null) return false;
    return ib.y >= lb.y - 1 && ib.y + ib.height <= lb.y + lb.height + 1;
  };

  // ↑ で末尾 (date) を選択 → 下端の項目でもリストの表示範囲内に収まる
  await page.keyboard.press('ArrowUp');
  await expect(lastItem).toHaveClass(/selected/);
  await expect.poll(() => inViewport(lastItem)).toBe(true);

  // ↓ で先頭 (table) に戻る → こちらも表示範囲内
  await page.keyboard.press('ArrowDown');
  await expect(firstItem).toHaveClass(/selected/);
  await expect.poll(() => inViewport(firstItem)).toBe(true);
});
