/**
 * Story S45fa45-1 mock テスト (tags プロパティ値の `#` 候補補完)。
 * page.route で /api/tags を差し替え、候補メニューの表示・件数・インクリメンタル
 * 絞り込み・新規作成・キーボード操作・IME 誤発火防止を実ブラウザで固める。
 * 受け入れ本検証 (実ファイル + 実サーバー) は tag-suggest.e2e.spec.ts。
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

const FM_NOTE = ['---', 'tags: [alpha]', '---', '', 'アンカー行。', ''].join('\n');

function journal(content: string): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime: 1000 };
}

async function open(page: Page, tags: unknown = { tags: TAGS }): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] })),
  );
  await page.route('**/api/journal', (route) => void route.fulfill(json(journal(FM_NOTE))));
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(journal(FM_NOTE)));
  });
  await page.route('**/api/tags', (route) => void route.fulfill(json(tags)));
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
  return unexpected;
}

test('[MOCK] tags 値で # を打つと件数付き候補が出て、続く入力で絞り込める', async ({ page }) => {
  const unexpected = await open(page);
  const input = page.getByTestId('properties-chip-input');
  await input.click();
  await input.pressSequentially('#');

  const menu = page.getByTestId('tag-suggest-menu');
  await expect(menu).toBeVisible();
  // 空クエリ = 全既存タグ (件数付き)、新規作成は出さない
  await expect(menu.locator('[data-testid="tag-suggest-option"]')).toHaveCount(3);
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-book"] .cnt')).toHaveText('12');
  await expect(menu.locator('.tag-opt.create-new')).toHaveCount(0);

  // `#sam` へ絞り込み → sample-book / sample-project + 新規作成: #sam
  await input.pressSequentially('sam');
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-book"]')).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-project"]')).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="science"]')).toHaveCount(0);
  const create = menu.locator('.tag-opt.create-new[data-tag="sam"]');
  await expect(create).toBeVisible();
  await expect(create).toContainText('新規作成: #sam');
  // 一致範囲が mark でハイライトされる
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-book"] mark')).toHaveText('sam');

  expect(unexpected).toEqual([]);
});

test('[MOCK] 候補をクリックで選ぶと tags にチップが追加される', async ({ page }) => {
  await open(page);
  const widget = page.getByTestId('properties-widget');
  const input = page.getByTestId('properties-chip-input');
  await input.click();
  await input.pressSequentially('#sample-b');
  const menu = page.getByTestId('tag-suggest-menu');
  await menu.locator('[data-testid="tag-suggest-option"][data-tag="sample-book"]').click();

  await expect(widget.locator('[data-testid="properties-chip"][data-value="sample-book"]')).toBeVisible();
  // 既存 alpha + 追加 sample-book
  await expect(widget.locator('[data-testid="properties-chip"]')).toHaveCount(2);
  await expect(input).toHaveValue('');
});

test('[MOCK] ↑↓ で選択を移動し Enter で確定、Esc でメニューを閉じる', async ({ page }) => {
  await open(page);
  const widget = page.getByTestId('properties-widget');
  const input = page.getByTestId('properties-chip-input');
  await input.click();
  await input.pressSequentially('#sam');
  const menu = page.getByTestId('tag-suggest-menu');
  await expect(menu).toBeVisible();

  // 先頭は sample-book が選択済み。↓ で sample-project へ移動して Enter
  await input.press('ArrowDown');
  await expect(menu.locator('.tag-opt.sel[data-tag="sample-project"]')).toBeVisible();
  await input.press('Enter');
  await expect(widget.locator('[data-testid="properties-chip"][data-value="sample-project"]')).toBeVisible();

  // 再度開いて Esc で閉じる (チップは増えない)
  await input.pressSequentially('#sci');
  await expect(menu).toBeVisible();
  await input.press('Escape');
  await expect(menu).toBeHidden();
  await expect(widget.locator('[data-testid="properties-chip"]')).toHaveCount(2);
});

test('[MOCK] 候補ソースが空でも 新規作成 だけは提示される', async ({ page }) => {
  await open(page, { tags: [] });
  const input = page.getByTestId('properties-chip-input');
  await input.click();
  await input.pressSequentially('#newtag');
  const menu = page.getByTestId('tag-suggest-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"]')).toHaveCount(1);
  await expect(menu.locator('.tag-opt.create-new[data-tag="newtag"]')).toBeVisible();
});
