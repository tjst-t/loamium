/**
 * Story S9e5ca4-4 mock テスト (highlight のエッジケース)。
 * page.route で全 /api/* をモックする (gui-spec-S9e5ca4-4.json 参照)。
 * 受け入れ条件の本検証は highlight.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
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

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openWithJournal(page: Page, content: string, waitText: string): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  await editorLine(page, waitText).click();
  return unexpected;
}

test('[MOCK] ==== や空内容・先頭空白はハイライトしない', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['====', '== ==', '== 先頭が空白 ==', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );

  await expect(page.getByTestId('highlight')).toHaveCount(0);
  await expect(editorLine(page, '====')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 1 行に複数の ==highlight== がそれぞれ独立に描画される', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['==最初== と ==二番目== を強調。', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );

  const marks = page.getByTestId('highlight');
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveText('最初');
  await expect(marks.nth(1)).toHaveText('二番目');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 内側に単独の = を含む ==a=b== は 1 つのハイライトになる', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['計算式 ==x=1== を強調。', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );

  const marks = page.getByTestId('highlight');
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText('x=1');
  expect(unexpected).toEqual([]);
});
