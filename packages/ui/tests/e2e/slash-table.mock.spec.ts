/**
 * Story Sd40b63-2 mock テスト (テーブルサイズピッカー + スクロール追従の UI 挙動)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証は
 * slash-table.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime: 1000 };
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openApp(page: Page, content: string, waitText: string): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.route(`**/api/notes/journals/**`, (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  return unexpected;
}

async function openMenu(page: Page): Promise<void> {
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
}

test('[MOCK] テーブル項目でグリッドピッカーが開き、ホバーでサイズが変わり、クリックで挿入される', async ({
  page,
}) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  await page.locator('[data-testid="slash-item"][data-command="table"]').click();
  const picker = page.getByTestId('slash-table-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('slash-table-picker-label')).toHaveText('3 列 × 3 行');

  // 8×8 のグリッドが並ぶ
  await expect(page.getByTestId('slash-table-picker-cell')).toHaveCount(64);

  // 2 列 × 4 行 のセルにホバー → ラベルが追従
  await page.locator('[data-testid="slash-table-picker-cell"][data-cols="2"][data-rows="4"]').hover();
  await expect(page.getByTestId('slash-table-picker-label')).toHaveText('2 列 × 4 行');

  // クリックで確定 → 2 列のヘッダ + 区切り + 4 データ行 (標準 Markdown)
  await page.locator('[data-testid="slash-table-picker-cell"][data-cols="2"][data-rows="4"]').click();
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  await expect(editorLine(page, '見出し1')).toContainText('| 見出し1 | 見出し2 |');
  await expect(page.getByTestId('editor')).toContainText('| --- | --- |');
  expect(unexpected).toEqual([]);
});

test('[MOCK] Esc でピッカーからコマンドリストへ戻る (メニューは閉じない)', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  // キーボード操作で table を選び (エディタにフォーカスが残る)、ピッカーを開く
  await page.keyboard.type('table');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slash-table-picker')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('slash-table-picker')).toBeHidden();
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  // コマンドリストへ戻る (query 'table' は table と dataview の 2 件に一致)
  await expect(page.locator('[data-testid="slash-item"][data-command="table"]')).toBeVisible();
  await expect(page.getByTestId('slash-item')).toHaveCount(2);
  expect(unexpected).toEqual([]);
});

test('[MOCK] ↑↓ キーボード選択で下端の項目が表示範囲内に収まる (スクロール追従)', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  const list = page.locator('.slash-list');
  const lastItem = page.locator('[data-testid="slash-item"][data-command="date"]');
  await page.keyboard.press('ArrowUp'); // 末尾 (date) へラップ
  await expect(lastItem).toHaveClass(/selected/);

  await expect
    .poll(async () => {
      const lb = await list.boundingBox();
      const ib = await lastItem.boundingBox();
      if (lb === null || ib === null) return false;
      return ib.y >= lb.y - 1 && ib.y + ib.height <= lb.y + lb.height + 1;
    })
    .toBe(true);
  expect(unexpected).toEqual([]);
});
