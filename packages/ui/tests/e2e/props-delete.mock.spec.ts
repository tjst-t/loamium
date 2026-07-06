/**
 * Story Sd13ab1-3 mock テスト (行削除UI)。
 * page.route で全 /api/* をモックし、行の × 削除と全削除でブロック除去を固める。
 * 受け入れ本検証 (実ファイル) は props-delete.e2e.spec.ts。
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

async function expand(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-summary').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
}

test('[MOCK] 行の × でその行が削除される', async ({ page }) => {
  const unexpected = await open(
    page,
    ['---', 'status: 読了', 'rating: 4', '---', '', 'アンカー行。', ''].join('\n'),
  );
  await expand(page);
  await expect(page.getByTestId('properties-row')).toHaveCount(2);

  const statusRow = page.locator('[data-testid="properties-row"][data-key="status"]');
  await statusRow.hover();
  await statusRow.locator('[data-testid="properties-row-delete"]').click();
  await expect(page.getByTestId('properties-row')).toHaveCount(1);
  await expect(statusRow).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 全削除で frontmatter ブロックが消え、空ノート入口に戻る', async ({ page }) => {
  const unexpected = await open(
    page,
    ['---', 'status: x', 'rating: 2', '---', '', 'アンカー行。', ''].join('\n'),
  );
  await expand(page);
  const del = () => page.locator('[data-testid="properties-row-delete"]').first();
  await del().click();
  await del().click();
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('properties-empty-add')).toBeVisible();
  await expect(page.getByTestId('editor')).not.toContainText('---');
  expect(unexpected).toEqual([]);
});
