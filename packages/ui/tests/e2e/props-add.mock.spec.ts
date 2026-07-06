/**
 * Story Sd13ab1-2 mock テスト (キーファースト追加メニュー)。
 * page.route で全 /api/* をモックし、2 ゾーン候補・絞り込み・既存無効・新規型セレクタ
 * を実ブラウザで固める。実サーバー横断検証は props-add.e2e.spec.ts。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-06';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

async function open(page: Page, content: string): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  // vault 横断キー: 他ファイルで作った hoge を含む (件数付き)
  await page.route('**/api/property-keys', (route) => {
    void route.fulfill(json({ keys: [{ key: 'hoge', count: 3 }, { key: 'status', count: 5 }] }));
  });
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  return unexpected;
}

const NOTE = ['---', 'status: 進行中', '---', '', 'アンカー行。', ''].join('\n');

async function expandAndOpenMenu(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-summary').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
  await widget.getByTestId('properties-add').click();
  await expect(page.getByTestId('property-add-menu')).toBeVisible();
}

test('[MOCK] キー候補メニューが 2 ゾーン。既存キーは無効、vault キー hoge がサジェストされる', async ({
  page,
}) => {
  const unexpected = await open(page, NOTE);
  await expandAndOpenMenu(page);
  const menu = page.getByTestId('property-add-menu');

  // vault 横断サジェスト: 他ファイルで作った hoge が候補に出る
  await menu.getByTestId('property-add-filter').fill('hoge');
  await expect(menu.locator('[data-testid="property-add-known"][data-key="hoge"]')).toBeVisible();

  // この文書に既にある status は無効 (data-existing=true)
  await menu.getByTestId('property-add-filter').fill('status');
  const existing = menu.locator('[data-testid="property-add-known"][data-key="status"]');
  await expect(existing).toHaveAttribute('data-existing', 'true');
  await expect(existing).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 既知/一意キーを選ぶと即追加され、型は D方式でキーから決まる', async ({ page }) => {
  const unexpected = await open(page, NOTE);
  await expandAndOpenMenu(page);
  const menu = page.getByTestId('property-add-menu');

  await menu.getByTestId('property-add-filter').fill('rating');
  await menu.locator('[data-testid="property-add-known"][data-key="rating"]').click();
  const row = page.locator('[data-testid="properties-row"][data-key="rating"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.pc-star')).toHaveCount(5); // D方式: rating→star
  expect(unexpected).toEqual([]);
});

test('[MOCK] 新規キーは名前→汎用型セレクタで型を選び追加される', async ({ page }) => {
  const unexpected = await open(page, NOTE);
  await expandAndOpenMenu(page);
  const menu = page.getByTestId('property-add-menu');

  await menu.getByTestId('property-add-filter').fill('レビュー');
  await menu.getByTestId('property-add-new').click();
  // 汎用型セレクタ (property-new-type) が出る
  await expect(menu.getByTestId('property-new-type-wrap')).toBeVisible();
  await menu.locator('[data-testid="property-new-type"][data-type="number"]').click();

  const row = page.locator('[data-testid="properties-row"][data-key="レビュー"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-type="number"]')).toBeVisible();
  expect(unexpected).toEqual([]);
});
