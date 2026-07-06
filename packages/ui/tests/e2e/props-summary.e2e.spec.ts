/**
 * Story Sd13ab1-1「畳み時の値要約バー」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * ビジュアルの正は prototype/props-redesign/chosen-v2.html (A 欄)。
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

async function openNoteFromTree(page: Page, rel: string, waitText: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
}

test('[AC-Sd13ab1-1-1] 畳み状態で `>` の後にプロパティ値の要約が出る (ラベル語なし)', async ({
  page,
}) => {
  await putNote(
    'summary/vals.md',
    [
      '---',
      'tags: [sample-book, science]',
      'status: 読了',
      'rating: 4',
      'created: 2026-05-20',
      '---',
      '',
      '# 失敗から学ぶ',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'summary/vals.md', 'アンカー行');

  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  await expect(widget).toHaveAttribute('data-open', 'false');

  // 畳み時: 値要約バー (properties-summary) が見える
  const summary = widget.getByTestId('properties-summary');
  await expect(summary).toBeVisible();
  // 値の要約: tags チップ (#) + status ラベル + 日付
  await expect(summary).toContainText('#sample-book');
  await expect(summary).toContainText('#science');
  await expect(summary).toContainText('読了');
  await expect(summary).toContainText('2026-05-20');
  // 『プロパティ』というラベル語は出さない (値/キー名のみ)
  await expect(summary).not.toContainText('プロパティ');

  // 密行は畳み時は非表示 (要約バーだけで中身が把握できる)
  await expect(widget.getByTestId('properties-row').first()).toBeHidden();
});

test('[AC-Sd13ab1-1-2] 要約バークリックで展開、`>` で畳みトグル。展開は2カラム密行', async ({
  page,
}) => {
  await putNote(
    'summary/toggle.md',
    ['---', 'status: 進行中', 'rating: 3', '---', '', 'アンカー行。', ''].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'summary/toggle.md', 'アンカー行');

  const widget = page.getByTestId('properties-widget');
  await expect(widget).toHaveAttribute('data-open', 'false');

  // 要約バークリックで展開 (data-open=true)
  await widget.getByTestId('properties-summary').click();
  await expect(widget).toHaveAttribute('data-open', 'true');

  // 展開時は従来の 2 カラム密行 (キー + 値)
  const statusRow = widget.locator('[data-testid="properties-row"][data-key="status"]');
  await expect(statusRow).toBeVisible();
  await expect(statusRow).toContainText('進行中');
  await expect(
    widget.locator('[data-testid="properties-row"][data-key="rating"] .pc-star'),
  ).toHaveCount(5);

  // `>` トグルで再度畳む → 要約バーに戻る
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expect(statusRow).toBeHidden();
  await expect(widget.getByTestId('properties-summary')).toBeVisible();
});

test('[AC-Sd13ab1-1-1] プロパティが多いと要約バーは末尾に +N で件数を示す', async ({ page }) => {
  await putNote(
    'summary/many.md',
    [
      '---',
      'tags: [a]',
      'status: 読了',
      'rating: 4',
      'created: 2026-05-20',
      'due: 2026-06-01',
      'k6: v6',
      'k7: v7',
      'k8: v8',
      '---',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'summary/many.md', 'アンカー行');

  const summary = page.getByTestId('properties-widget').getByTestId('properties-summary');
  await expect(summary).toBeVisible();
  // 8 プロパティ > 上限 6 → +2 の overflow 表示
  await expect(summary.locator('.pc-sum-more')).toContainText('+2');
});
