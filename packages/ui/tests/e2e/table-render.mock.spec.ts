/**
 * Story S79c210-2 mock テスト (テーブル描画のエッジケース)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証は
 * table-render.e2e.spec.ts (実サーバー) が行う。
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

test('[MOCK] 区切り行の無いパイプ行はテーブルにならず、揃え指定は列に反映される', async ({
  page,
}) => {
  const unexpected = await openWithJournal(
    page,
    [
      '| これは | 区切り行の無い | ただの行 |',
      '',
      '| 左 | 中 | 右 |',
      '| :--- | :---: | ---: |',
      '| a | b | c |',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
    'アンカー行',
  );

  // 区切り行の無いパイプ行はテーブルにならない (ソースのまま見える)
  await expect(editorLine(page, '区切り行の無い')).toBeVisible();

  // 正しい GFM テーブルは 1 つだけ描画され、揃え指定が反映される
  const tables = page.getByTestId('table-widget');
  await expect(tables).toHaveCount(1);
  const cells = tables.first().locator('tbody tr').first().locator('td');
  await expect(cells.nth(0)).toHaveCSS('text-align', 'left');
  await expect(cells.nth(1)).toHaveCSS('text-align', 'center');
  await expect(cells.nth(2)).toHaveCSS('text-align', 'right');
  expect(unexpected).toEqual([]);
});

test('[MOCK] テーブル行にカーソルを置くとソース (パイプ記法) に戻り、外すと再描画される', async ({
  page,
}) => {
  const unexpected = await openWithJournal(
    page,
    ['| H1 | H2 |', '| --- | --- |', '| x | y |', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );

  const table = page.getByTestId('table-widget');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveCount(2);

  // セルクリックで編集 input が開き、そのセルのソースが見える (WYSIWYG 編集)
  await table.locator('tbody tr').first().locator('td').first().locator('.cell-body').click();
  const cellInput = page.getByTestId('table-cell-input');
  await expect(cellInput).toBeVisible();
  await expect(cellInput).toHaveValue('x');

  // フォーカスを外すと再びテーブル描画
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('table-widget')).toBeVisible();
  expect(unexpected).toEqual([]);
});
