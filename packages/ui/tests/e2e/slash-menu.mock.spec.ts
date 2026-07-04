/**
 * Story S763a98-1 mock テスト (スラッシュコマンドメニューのエッジ・操作ケース)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証は
 * slash-menu.e2e.spec.ts (実サーバー) が行う。
 *
 * ここでは絞り込み・抑制 (コードフェンス/インラインコード)・キーボードナビ・
 * クリック挿入・Esc といった UI 挙動を実ブラウザ + モック API で固める。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string, mtime = 1000): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime };
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

/** アンカー行末で改行し `/` を打ってメニューを開く。 */
async function openMenu(page: Page): Promise<void> {
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
}

test('[MOCK] 行頭で / を打つとメニューが開き、8 コマンドが並び、Esc で閉じる', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  const menu = page.getByTestId('slash-menu');
  await expect(page.getByTestId('slash-item')).toHaveCount(8);
  // filter-echo が現在のクエリ (/) を表示
  await expect(menu.locator('.filter-echo')).toHaveText('/');
  // 契約された data-command が揃っている
  for (const cmd of ['table', 'callout', 'code', 'mermaid', 'dataview', 'checkbox', 'heading', 'date']) {
    await expect(page.locator(`[data-testid="slash-item"][data-command="${cmd}"]`)).toBeVisible();
  }
  // 先頭が選択済み
  await expect(page.locator('[data-testid="slash-item"][data-command="table"]')).toHaveClass(/selected/);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  // Esc 後に同じ / 位置では再オープンしない (カーソルはそのまま)
  expect(unexpected).toEqual([]);
});

test('[MOCK] 入力で絞り込まれ、タイトル一致は mark 表示、無一致は empty state', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  // "mer" → mermaid だけ (タイトル一致 → mark ハイライト)
  await page.keyboard.type('mer');
  await expect(page.locator('.filter-echo')).toHaveText('/mer');
  await expect(page.getByTestId('slash-item')).toHaveCount(1);
  const mermaid = page.locator('[data-testid="slash-item"][data-command="mermaid"]');
  await expect(mermaid).toBeVisible();
  await expect(mermaid.locator('mark')).toHaveText('mer');

  // キーワード一致 (タイトル外) も候補に残る: "todo" → checkbox
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('todo');
  await expect(page.getByTestId('slash-item')).toHaveCount(1);
  await expect(page.locator('[data-testid="slash-item"][data-command="checkbox"]')).toBeVisible();

  // 無一致 → empty state
  await page.keyboard.type('zzz');
  await expect(page.getByTestId('slash-item')).toHaveCount(0);
  await expect(page.getByTestId('slash-menu-empty')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] ↑↓ で選択が動き、Enter で選択中コマンドが標準 Markdown で挿入される', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  // 先頭 table → ArrowDown で callout が選択される
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-testid="slash-item"][data-command="callout"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-testid="slash-item"][data-command="table"]')).not.toHaveClass(/selected/);
  // ArrowUp で先頭 (table) に戻る
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-testid="slash-item"][data-command="table"]')).toHaveClass(/selected/);
  // ArrowUp でラップアラウンド (末尾 date)
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-testid="slash-item"][data-command="date"]')).toHaveClass(/selected/);

  // date を Enter 挿入 → 標準の YYYY-MM-DD 文字列、メニューは閉じる
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText(/\d{4}-\d{2}-\d{2}/);
  expect(unexpected).toEqual([]);
});

test('[MOCK] クリックで項目を選ぶとテーブル雛形 (標準 Markdown) が挿入される', async ({ page }) => {
  const unexpected = await openApp(page, 'メモ。\n\nアンカー行。\n', 'アンカー行');
  await openMenu(page);

  await page.locator('[data-testid="slash-item"][data-command="table"]').click();
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  // ブロック ID も独自記法もない標準 Markdown テーブル雛形
  await expect(editorLine(page, '見出し1')).toContainText('| 見出し1 | 見出し2 | 見出し3 |');
  await expect(page.getByTestId('editor')).toContainText('| --- | --- | --- |');
  expect(unexpected).toEqual([]);
});

test('[MOCK] コードフェンス内では / メニューが開かない', async ({ page }) => {
  const content = ['```text', 'CODEBODY', '```', '', 'アンカー行。', ''].join('\n');
  const unexpected = await openApp(page, content, 'アンカー行');

  await editorLine(page, 'CODEBODY').click();
  await page.keyboard.press('Home');
  await page.keyboard.type('/');
  // フェンス内なので発火しない
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] インラインコード内では / メニューが開かない', async ({ page }) => {
  const content = ['設定は `a b` を使う。', '', 'アンカー行。', ''].join('\n');
  const unexpected = await openApp(page, content, 'アンカー行');

  // `a b` のコード内 (空白の直後) にカーソルを置いて / を打つ
  await editorLine(page, '設定は').click();
  await page.keyboard.press('Home');
  // "設定は " (4) + "`" (1) + "a" (1) + " " (1) = 7 文字右へ → コード内の空白直後
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('/');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  // 対照: コード外 (アンカー行) の行頭 / では開く
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  expect(unexpected).toEqual([]);
});
