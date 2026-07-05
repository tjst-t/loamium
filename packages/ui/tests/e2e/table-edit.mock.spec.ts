/**
 * Story Sd40b63-1 mock テスト (テーブル WYSIWYG 編集の UI 挙動)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証 (実ファイル書込) は
 * table-edit.e2e.spec.ts (実サーバー) が行う。
 *
 * ここではセル編集の input 開閉・再描画、行/列の追加削除といった UI 操作を
 * 実ブラウザ + モック API で固める。
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

test('[MOCK] セルをクリックすると input が開き、編集後フォーカスを外すと表として再描画される', async ({
  page,
}) => {
  const unexpected = await openWithJournal(
    page,
    ['| 名前 | 数 |', '| --- | --- |', '| りんご | 12 |', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await editorLine(page, 'アンカー行').click();
  const table = page.getByTestId('table-widget');
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute('data-editable', 'true');

  // セルクリック → input、現在値、書き換え
  await table.locator('tbody tr').first().locator('td').first().locator('.cell-body').click();
  const input = page.getByTestId('table-cell-input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('りんご');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ばなな');

  // 外すと再描画 (input 消滅、セルに新しい値)
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('table-cell-input')).toHaveCount(0);
  await expect(
    page.getByTestId('table-widget').locator('tbody tr').first().locator('td').first(),
  ).toHaveText('ばなな');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 行・列の追加/削除でグリッドが変化する', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await editorLine(page, 'アンカー行').click();
  const table = page.getByTestId('table-widget');
  await expect(table.locator('thead th')).toHaveCount(2);
  await expect(table.locator('tbody tr')).toHaveCount(1);

  await page.getByTestId('table-add-row').click();
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(2);

  await page.getByTestId('table-add-col').click();
  await expect(page.getByTestId('table-widget').locator('thead th')).toHaveCount(3);

  await page.locator('[data-testid="table-del-col"][data-col="2"]').click();
  await expect(page.getByTestId('table-widget').locator('thead th')).toHaveCount(2);

  await page.locator('[data-testid="table-del-row"][data-row="1"]').click();
  await expect(page.getByTestId('table-widget').locator('tbody tr')).toHaveCount(1);
  expect(unexpected).toEqual([]);
});
