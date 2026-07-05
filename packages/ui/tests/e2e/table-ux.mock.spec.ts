/**
 * Story Sa629e2-1 mock テスト (テーブル WYSIWYG の UX 仕上げ)。
 * page.route で全 /api/* をモックし、UI 挙動 (コントロールの寸法・クリック編集の
 * 信頼性・Tab/Enter ナビゲーション・ソース編集切替) を実ブラウザで固める。
 * 受け入れ条件の本検証 (実ファイル書込) は table-ux.e2e.spec.ts が行う。
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

const TABLE_NOTE = ['| 名前 | 数 |', '| --- | --- |', '| りんご | 12 |', '| みかん | 3 |', '', 'アンカー行。', ''].join(
  '\n',
);

test('[MOCK] 行/列追加コントロールとソース編集ボタンがテーブルの寸法に収まる', async ({ page }) => {
  const unexpected = await openWithJournal(page, TABLE_NOTE, 'アンカー行');
  await editorLine(page, 'アンカー行').click();
  const widget = page.getByTestId('table-widget');
  await expect(widget).toBeVisible();
  await widget.hover();

  const tableBox = await widget.locator('table.md-table').boundingBox();
  const addRowBox = await page.getByTestId('table-add-row').boundingBox();
  const addColBox = await page.getByTestId('table-add-col').boundingBox();
  const editorBox = await page.getByTestId('editor').boundingBox();
  if (tableBox === null || addRowBox === null || addColBox === null || editorBox === null) {
    throw new Error('bounding box が取得できませんでした');
  }
  // 行追加バーはテーブル幅に収まる (エディタ幅いっぱいに伸びない)
  expect(addRowBox.width).toBeLessThanOrEqual(tableBox.width + 4);
  expect(addRowBox.width).toBeLessThan(editorBox.width * 0.8);
  // 列追加バーはテーブル高さに収まる
  expect(addColBox.height).toBeLessThanOrEqual(tableBox.height + 4);
  expect(unexpected).toEqual([]);
});

test('[MOCK] セルのパディング領域 (テキスト外) を 1 クリックしても編集 input が開きフォーカスされる', async ({
  page,
}) => {
  const unexpected = await openWithJournal(page, TABLE_NOTE, 'アンカー行');
  await editorLine(page, 'アンカー行').click();
  // 先頭列のセル (行削除ボタンが無い列) のパディング領域をクリックする
  const td = page.getByTestId('table-widget').locator('tbody tr').first().locator('td').first();
  const box = await td.boundingBox();
  if (box === null) throw new Error('td の bounding box が取得できませんでした');
  // セル右端近く (テキスト span の外) をクリック
  await td.click({ position: { x: box.width - 3, y: box.height / 2 } });
  const input = page.getByTestId('table-cell-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('りんご');
  // クリック直後にそのまま入力できる
  await page.keyboard.type('あ');
  await expect(input).toHaveValue('りんごあ');
  expect(unexpected).toEqual([]);
});

test('[MOCK] Tab/Shift+Tab/Enter でセル間を移動できる (コミットしてから移動)', async ({ page }) => {
  const unexpected = await openWithJournal(page, TABLE_NOTE, 'アンカー行');
  await editorLine(page, 'アンカー行').click();
  const widget = page.getByTestId('table-widget');
  await widget.locator('tbody tr').first().locator('td').first().locator('.cell-body').click();
  const input = page.getByTestId('table-cell-input');
  await expect(input).toHaveValue('りんご');

  // 値を書き換えて Tab → コミットされ右セルの編集が開く
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ばなな');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('12');
  // コミット済み: セル表示は新しい値
  await expect(
    page.getByTestId('table-widget').locator('tbody tr').first().locator('td').first(),
  ).toHaveText('ばなな');

  // 行末セルで Tab → 次行の先頭セルへ
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('みかん');

  // Shift+Tab → 左 (前) のセルへ戻る
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('12');

  // Enter → 下のセルへ
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('table-cell-input')).toHaveValue('3');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 最終セルの Tab で行が追加され、新しい行の先頭セルの編集が始まる', async ({ page }) => {
  const unexpected = await openWithJournal(page, TABLE_NOTE, 'アンカー行');
  await editorLine(page, 'アンカー行').click();
  const widget = page.getByTestId('table-widget');
  await expect(widget.locator('tbody tr')).toHaveCount(2);

  // 最終セル (2 行目の「3」) を開いて Tab
  await widget.locator('tbody tr').nth(1).locator('td').nth(1).locator('.cell-body').click();
  await expect(page.getByTestId('table-cell-input')).toHaveValue('3');
  await page.keyboard.press('Tab');

  // 行が追加され、新行の先頭セル (空) の編集が始まる
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(3);
  const input = page.getByTestId('table-cell-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await page.keyboard.type('ぶどう');
  await page.keyboard.press('Escape');
  await expect(
    page.getByTestId('table-widget').locator('tbody tr').nth(2).locator('td').first(),
  ).toHaveText('');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 『ソースを編集』でテーブル行のソース表示に切り替わり、カーソルがテーブルに入る', async ({
  page,
}) => {
  const unexpected = await openWithJournal(page, TABLE_NOTE, 'アンカー行');
  await editorLine(page, 'アンカー行').click();
  const widget = page.getByTestId('table-widget');
  await expect(widget).toBeVisible();
  await widget.hover();
  await page.getByTestId('table-edit-source').click();

  // widget が外れ、ソース (| 記法) が表示される
  await expect(page.getByTestId('table-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('| 名前 | 数 |');
  // カーソルはテーブル行 (先頭行) に入っている
  await expect(page.locator('[data-testid="editor"] .cm-activeLine')).toContainText('| 名前 | 数 |');
  expect(unexpected).toEqual([]);
});
