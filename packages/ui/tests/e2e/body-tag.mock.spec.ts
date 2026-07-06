/**
 * Story S45fa45-2 mock テスト (本文の `#` 判定 + タグ補完)。
 * page.route で /api/tags を差し替え、`# ` = 見出し / `#tag` = タグ装飾 の判定、
 * 本文 `#` の候補メニュー (S45fa45-1 と同一ソース)・絞り込み・IME 誤発火防止を
 * 実ブラウザで固める。受け入れ本検証 (実ファイル + 実サーバー) は body-tag.e2e.spec.ts。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-06';
const JOURNAL_PATH = `journals/${DATE}.md`;

const TAGS = [
  { tag: 'sample-book', count: 12 },
  { tag: 'sample-project', count: 7 },
  { tag: 'science', count: 3 },
];

const CONTENT = ['# 失敗から学ぶ', '', 'この本は #sample-book です', '', 'アンカー行。', ''].join('\n');

function journal(content: string): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime: 1000 };
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function open(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] })),
  );
  await page.route('**/api/journal', (route) => void route.fulfill(json(journal(CONTENT))));
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(journal(CONTENT)));
  });
  await page.route('**/api/tags', (route) => void route.fulfill(json({ tags: TAGS })));
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  return unexpected;
}

test('[MOCK] `# ` はH1見出し、`#tag`(スペース無し)はインラインタグ装飾になる', async ({ page }) => {
  const unexpected = await open(page);
  // カーソルを中立な行へ移し、見出し行・タグ行の装飾を表示させる
  await editorLine(page, 'アンカー行').click();

  // `# 失敗から学ぶ` は見出し (H1 スタイル) として描画される
  await expect(page.locator('.cm-md-h1')).toContainText('失敗から学ぶ');

  // `#sample-book` はタグチップ (body-tag) になる。見出しスタイルは付かない
  const tag = page.locator('[data-testid="body-tag"][data-tag="sample-book"]');
  await expect(tag).toBeVisible();
  await expect(tag).toHaveText('#sample-book');

  expect(unexpected).toEqual([]);
});

test('[MOCK] 本文 `#` でタグ候補メニュー(同一ソース)が出て絞り込める', async ({ page }) => {
  await open(page);
  // アンカー行末尾に ` #sam` を入力 (# の直前はスペース = タグ判定)
  const line = editorLine(page, 'アンカー行');
  await line.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' #sam');

  const menu = page.getByTestId('tag-suggest-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-book"] .cnt')).toHaveText('12');
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-project"]')).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="science"]')).toHaveCount(0);
  await expect(menu.locator('.tag-opt.create-new[data-tag="sam"]')).toBeVisible();
});

test('[MOCK] 本文 `# `(直後スペース)ではタグメニューを出さない(見出し扱い)', async ({ page }) => {
  await open(page);
  const line = editorLine(page, 'アンカー行');
  await line.click();
  await page.keyboard.press('Enter'); // 新しい空行
  await page.keyboard.type('# 見出しっぽい行');
  await expect(page.getByTestId('tag-suggest-menu')).toBeHidden();
});

test('[MOCK] 本文 `#` 候補を選ぶと `#tag` が挿入され、装飾チップになる', async ({ page }) => {
  await open(page);
  const line = editorLine(page, 'アンカー行');
  await line.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' #sci');
  const menu = page.getByTestId('tag-suggest-menu');
  await menu.locator('[data-testid="tag-suggest-option"][data-tag="science"]').click();

  // カーソルを別行へ移すと確定タグが装飾される
  await editorLine(page, '失敗から学ぶ').click();
  await expect(page.locator('[data-testid="body-tag"][data-tag="science"]')).toBeVisible();
});
