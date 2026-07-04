/**
 * Story S9e5ca4-3 mock テスト (callout のエッジケース)。
 * page.route で全 /api/* をモックする (gui-spec-S9e5ca4-3.json 参照)。
 * 受け入れ条件の本検証は callout.e2e.spec.ts (実サーバー) が行う。
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

test('[MOCK] 連続する > 行は 1 つの callout 本文になり、次の > [!type] からは別 callout になる', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    [
      '> [!note] 一つ目',
      '> 1 行目の本文',
      '> 2 行目の本文',
      '> [!tip] 二つ目',
      '> tip の本文',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
    'アンカー行',
  );

  const callouts = page.getByTestId('callout');
  await expect(callouts).toHaveCount(2);
  const first = callouts.nth(0);
  await expect(first).toHaveAttribute('data-type', 'note');
  await expect(first).toContainText('1 行目の本文');
  await expect(first).toContainText('2 行目の本文');
  await expect(first).not.toContainText('tip の本文');
  const second = callouts.nth(1);
  await expect(second).toHaveAttribute('data-type', 'tip');
  await expect(second).toContainText('tip の本文');
  expect(unexpected).toEqual([]);
});

test('[MOCK] callout でない通常の > 引用は callout にならない / フェンス内の > [!note] も装飾しない', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    [
      '> ただの引用文。',
      '',
      '```',
      '> [!note] フェンス内はソースのまま',
      '```',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
    'アンカー行',
  );

  await expect(page.getByTestId('callout')).toHaveCount(0);
  await expect(editorLine(page, 'ただの引用文。')).toBeVisible();
  await expect(editorLine(page, '> [!note] フェンス内はソースのまま')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 本文なしの単独 [!warning] 行も callout になり、カーソルを置くとソースに戻る', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['> [!warning] タイトルだけ', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );

  const callout = page.locator('[data-testid="callout"][data-type="warning"]');
  await expect(callout).toBeVisible();
  await expect(callout.locator('.callout-title')).toContainText('タイトルだけ');

  // カーソルを置くとソースへ (クリック → 装飾が外れる)
  await callout.click();
  await expect(page.getByTestId('callout')).toHaveCount(0);
  await expect(editorLine(page, '> [!warning] タイトルだけ')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] [!NOTE] の大文字・[!hoge] の未知タイプはともに note スタイルに正規化される', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['> [!NOTE] 大文字タイプ', '', '> [!hoge] 未知タイプ', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );

  const callouts = page.getByTestId('callout');
  await expect(callouts).toHaveCount(2);
  await expect(callouts.nth(0)).toHaveAttribute('data-type', 'note');
  await expect(callouts.nth(1)).toHaveAttribute('data-type', 'note');
  expect(unexpected).toEqual([]);
});
