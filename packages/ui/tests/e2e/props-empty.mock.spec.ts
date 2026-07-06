/**
 * Story Sd13ab1-3 mock テスト (空ノートへの追加入口)。
 * page.route で全 /api/* をモックし、frontmatter 無しノートの入口 → メニュー →
 * frontmatter 生成を実ブラウザで固める。受け入れ本検証は props-empty.e2e.spec.ts。
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
  await expect(page.getByTestId('editor')).toContainText('本文のみ');
  return unexpected;
}

test('[MOCK] frontmatter 無しノートに追加入口が出て、選ぶと frontmatter が生成される', async ({
  page,
}) => {
  const unexpected = await open(page, '# メモ\n\n本文のみ。\n');
  // frontmatter widget は無く、控えめな入口だけが出る
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  const emptyAdd = page.getByTestId('properties-empty-add');
  await expect(emptyAdd).toBeVisible();

  await emptyAdd.click();
  await expect(page.getByTestId('property-add-menu')).toBeVisible();

  // tags を選ぶ → --- frontmatter が生成され widget が描画される
  await page.getByTestId('property-add-filter').fill('tags');
  await page.locator('[data-testid="property-add-known"][data-key="tags"]').click();
  await expect(page.getByTestId('properties-widget')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('本文のみ');
  expect(unexpected).toEqual([]);
});
