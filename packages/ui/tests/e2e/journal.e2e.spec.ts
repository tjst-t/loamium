/**
 * Story Sa704c3-2「デイリージャーナルへの着地」E2E 受け入れテスト。
 * 実ブラウザ + 実サーバー。「今日」はテストとサーバーが同一マシン・同一 TZ の前提で
 * shared の todayJournalDate() と一致する。
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { todayJournalDate, shiftJournalDate, journalPath } from '@loamium/shared';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

test('[AC-Sa704c3-2-1] アプリ起動時に今日のジャーナル (なければ自動生成) がエディタに開く', async ({ page }) => {
  const today = todayJournalDate();
  await page.goto(state().uiUrl);

  // 追加操作なしで今日のジャーナルが開いている
  await expect(page.getByTestId('journal-today')).toContainText(today);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor-empty-state')).toHaveCount(0);

  // ツリー上でも今日のジャーナルが選択されている (自動生成されたファイル)
  const treeItem = page.locator(`[data-testid="tree-item"][data-path="${journalPath(today)}"]`);
  await expect(treeItem).toBeVisible();
  await expect(treeItem).toHaveClass(/active/);

  // そのまま書き始められ、保存される
  const stamp = `ジャーナルE2E-${String(Date.now())}`;
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`${stamp}\n`);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 再起動 (リロード) しても今日のジャーナルに前回の内容が開く
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(stamp);

  // 自動生成されたファイルはピュア Markdown (journals/YYYY-MM-DD.md)
  const fileContent = await readFile(path.join(state().vault, journalPath(today)), 'utf8');
  expect(fileContent).toContain(stamp);
  expect(fileContent).not.toContain('id::');
});

test('[AC-Sa704c3-2-2] サイドバーの日付ナビゲーションで過去のジャーナルへ移動できる', async ({ page }) => {
  const today = todayJournalDate();
  const yesterday = shiftJournalDate(today, -1);
  const threeDaysAgo = shiftJournalDate(today, -3);

  await page.goto(state().uiUrl);
  await expect(page.getByTestId('journal-today')).toContainText(today);

  // 前日へ (フィクスチャで昨日のジャーナルが存在する)
  await page.getByTestId('journal-prev').click();
  await expect(page.getByTestId('editor')).toContainText('昨日のメモ');
  const yesterdayItem = page.locator(`[data-testid="tree-item"][data-path="${journalPath(yesterday)}"]`);
  await expect(yesterdayItem).toHaveClass(/active/);

  // 翌日 (=今日) へ戻る
  await page.getByTestId('journal-next').click();
  await expect(
    page.locator(`[data-testid="tree-item"][data-path="${journalPath(today)}"]`),
  ).toHaveClass(/active/);
  await expect(page.getByTestId('editor')).not.toContainText('昨日のメモ');

  // 一覧ポップアップから任意の過去日へ
  await page.getByTestId('journal-open-list').click();
  await expect(page.getByTestId('journal-list')).toBeVisible();
  const item = page.locator(`[data-testid="journal-list-item"][data-date="${threeDaysAgo}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId('editor')).toContainText('3日前のメモ');
  await expect(
    page.locator(`[data-testid="tree-item"][data-path="${journalPath(threeDaysAgo)}"]`),
  ).toHaveClass(/active/);

  // journal-today ボタンで今日へ復帰
  await page.getByTestId('journal-today').click();
  await expect(
    page.locator(`[data-testid="tree-item"][data-path="${journalPath(today)}"]`),
  ).toHaveClass(/active/);
});
