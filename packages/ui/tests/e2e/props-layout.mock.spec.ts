/**
 * Story S87f4b7-1 mock テスト (プロパティブロックの折りたたみ + 密行)。
 * page.route で全 /api/* をモックし、たたむ/開く挙動を実ブラウザで固める。
 * 受け入れ本検証 (実ファイル) は props-layout.e2e.spec.ts。
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

const NOTE = ['---', 'status: 進行中', 'rating: 4', '---', '', 'アンカー行。', ''].join('\n');

test('[MOCK] frontmatter があると既定で畳まれ、`>` トグルだけが見える', async ({ page }) => {
  const unexpected = await open(page, NOTE, 'アンカー行');
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expect(widget.getByTestId('properties-toggle')).toBeVisible();
  // 畳み時、密行は非表示 (DOM には残るが display:none で見えない = サマリを出さない)
  await expect(widget.getByTestId('properties-row').first()).toBeHidden();
  expect(unexpected).toEqual([]);
});

test('[MOCK] トグルで開閉でき、開くとミニマル密行が見える', async ({ page }) => {
  const unexpected = await open(page, NOTE, 'アンカー行');
  const widget = page.getByTestId('properties-widget');
  const toggle = widget.getByTestId('properties-toggle');

  await toggle.click();
  await expect(widget).toHaveAttribute('data-open', 'true');
  const statusRow = widget.locator('[data-testid="properties-row"][data-key="status"]');
  await expect(statusRow).toBeVisible();
  await expect(statusRow).toContainText('進行中');
  // rating は star 描画
  await expect(
    widget.locator('[data-testid="properties-row"][data-key="rating"] .pc-star'),
  ).toHaveCount(5);

  // 再クリックで畳む
  await toggle.click();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expect(statusRow).toBeHidden();
  expect(unexpected).toEqual([]);
});
