/**
 * Story Sd13ab1-1 mock テスト (畳み時の値要約バー)。
 * page.route で全 /api/* をモックし、要約バーの表示・トグルを実ブラウザで固める。
 * 受け入れ本検証 (実ファイル) は props-summary.e2e.spec.ts。
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

async function open(page: Page, content: string, waitText: string): Promise<string[]> {
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
  await expect(page.getByTestId('editor')).toContainText(waitText);
  return unexpected;
}

const NOTE = [
  '---',
  'tags: [sample-book, science]',
  'status: 読了',
  'rating: 4',
  'created: 2026-05-20',
  '---',
  '',
  'アンカー行。',
  '',
].join('\n');

test('[MOCK] 畳み時に値要約バーが見え、値チップ/テキストが並ぶ (ラベル語なし)', async ({
  page,
}) => {
  const unexpected = await open(page, NOTE, 'アンカー行');
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toHaveAttribute('data-open', 'false');
  const summary = widget.getByTestId('properties-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('#sample-book');
  await expect(summary).toContainText('読了');
  await expect(summary).not.toContainText('プロパティ');
  // 密行は畳み時は非表示
  await expect(widget.getByTestId('properties-row').first()).toBeHidden();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 要約バー/トグルで展開・畳みがトグルする', async ({ page }) => {
  const unexpected = await open(page, NOTE, 'アンカー行');
  const widget = page.getByTestId('properties-widget');
  const summary = widget.getByTestId('properties-summary');

  await summary.click();
  await expect(widget).toHaveAttribute('data-open', 'true');
  const statusRow = widget.locator('[data-testid="properties-row"][data-key="status"]');
  await expect(statusRow).toBeVisible();
  await expect(statusRow).toContainText('読了');

  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expect(statusRow).toBeHidden();
  await expect(summary).toBeVisible();
  expect(unexpected).toEqual([]);
});
