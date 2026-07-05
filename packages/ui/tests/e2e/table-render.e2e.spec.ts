/**
 * Story S79c210-2 E2E — Markdown テーブルのライブプレビュー描画。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

test('[AC-S79c210-2-1] テーブルはカーソル行以外で HTML テーブル描画、カーソルを置くとソースが見える', async ({
  page,
}) => {
  await putNote(
    'table/在庫表.md',
    [
      '# 在庫表',
      '',
      '| 商品 | 個数 | 状態 |',
      '| --- | ---: | :---: |',
      '| りんご | 12 | **在庫** |',
      '| みかん | 3 | 補充中 |',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await openApp(page);
  await page.locator('[data-testid="tree-item"][data-path="table/在庫表.md"]').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('在庫表');

  // カーソルをテーブル外 (アンカー行) に置く → HTML テーブルが描画される
  await editorLine(page, 'アンカー行').click();
  const tableWidget = page.getByTestId('table-widget');
  await expect(tableWidget).toBeVisible();
  // ヘッダ 3 列 + データ 2 行
  await expect(tableWidget.locator('thead th')).toHaveCount(3);
  await expect(tableWidget.locator('thead th').nth(0)).toHaveText('商品');
  await expect(tableWidget.locator('tbody tr')).toHaveCount(2);
  await expect(tableWidget.locator('tbody tr').first().locator('td').first()).toHaveText('りんご');
  // セル内のインライン記法 (**在庫**) は太字として描画される
  await expect(tableWidget.locator('tbody tr').first().locator('td strong')).toHaveText('在庫');
  // 生のパイプ記法はテーブル描画中は本文に出ない
  await expect(page.locator('[data-testid="editor"]')).not.toContainText('| 商品 | 個数 |');

  // セルをクリックするとインライン編集の input が開き、そのセルのソースが見える
  // (WYSIWYG 編集: カーソルを置いたセルはソース、外すと再描画 — Sd40b63-1 で発展)
  await tableWidget.locator('tbody tr').first().locator('td').nth(2).locator('.cell-body').click();
  const cellInput = page.getByTestId('table-cell-input');
  await expect(cellInput).toBeVisible();
  await expect(cellInput).toHaveValue('**在庫**');

  // フォーカスを外へ戻すと再びテーブル描画 (太字レンダリング) に戻る
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('table-widget')).toBeVisible();
  await expect(tableWidget.locator('tbody tr').first().locator('td strong')).toHaveText('在庫');
});

test('[AC-S79c210-2-2] スラッシュメニューの「テーブル」挿入結果が直後に表として描画される', async ({
  page,
}) => {
  await putNote('table/挿入テスト.md', ['# 挿入テスト', '', '本文。', '', ''].join('\n'));
  await openApp(page);
  await page.locator('[data-testid="tree-item"][data-path="table/挿入テスト.md"]').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('挿入テスト');

  // 末尾の空行にカーソルを置き、/table でメニューを開いて挿入する
  await editorLine(page, '本文。').click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('/table');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.locator('[data-testid="slash-item"][data-command="table"]').click();
  // サイズピッカーで 3×3 を選んで挿入
  await expect(page.getByTestId('slash-table-picker')).toBeVisible();
  await page.locator('[data-testid="slash-table-picker-cell"][data-cols="3"][data-rows="3"]').click();

  // 挿入直後、カーソルは先頭セルにあるためテーブル行はソース表示。
  // カーソルをテーブル外へ移すと表として描画される (セル編集でカーソル行のみソース)。
  await editorLine(page, '本文。').click();
  const tableWidget = page.getByTestId('table-widget');
  await expect(tableWidget).toBeVisible();
  await expect(tableWidget.locator('thead th')).toHaveCount(3);
  await expect(tableWidget.locator('thead th').first()).toHaveText('見出し1');
});
