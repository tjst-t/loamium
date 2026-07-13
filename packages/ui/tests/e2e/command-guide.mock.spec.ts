/**
 * スマートコマンドガイド mock テスト — S9e64e7-4。
 *
 * AC-S9e64e7-4-1: 空状態に smart-command-guide セクションが表示され、
 *                 「スマートコマンドの使い方」節を含む。
 * AC-S9e64e7-4-2: 当該ガイド節が空状態に表示されること(mock)。
 *                 既存の smart-folder-guide は不変であること。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

// ============================================================
// ヘルパー: 空状態を確実に表示させる共通セットアップ
// ============================================================

async function goToEmptyState(page: import('@playwright/test').Page): Promise<void> {
  await installCatchAll(page);
  // ノートなし (ツリー空)
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [] })),
  );
  // ジャーナル取得失敗 → 自動開封されないため empty-state が表示される
  await page.route('**/api/journal**', (route) =>
    void route.fulfill(json({ error: 'io_error', message: 'disk unavailable' }, 500)),
  );
  // スマートフォルダ一覧は空で応答 (smart-folder 系 route)
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [] })),
  );

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor-empty-state')).toBeVisible();
}

// ============================================================
// AC-S9e64e7-4-1/-2: smart-command-guide が空状態に表示される
// ============================================================

test(
  '[AC-S9e64e7-4-2] 空状態に smart-command-guide セクションが表示される',
  async ({ page }) => {
    await goToEmptyState(page);

    // [AC-S9e64e7-4-1] smart-command-guide が表示される
    const guide = page.getByTestId('smart-command-guide');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('スマートコマンドの使い方');
  },
);

test(
  '[AC-S9e64e7-4-1] smart-command-guide に定義・実行・編集の 3 項目が含まれる',
  async ({ page }) => {
    await goToEmptyState(page);

    const guide = page.getByTestId('smart-command-guide');

    // 定義の書き方 (commands/ フォルダ)
    await expect(guide).toContainText('commands/');
    await expect(guide).toContainText('loamium-command:');

    // コマンドパレットでの実行 (Ctrl+K / '>')
    await expect(guide).toContainText('コマンドパレットで実行');

    // 定義エディタでの編集 (補完含む)
    await expect(guide).toContainText('定義エディタで編集');
  },
);

test(
  '[AC-S9e64e7-4-2] 既存の smart-folder-guide は不変 (regression)',
  async ({ page }) => {
    await goToEmptyState(page);

    // smart-folder-guide は引き続き表示される
    const sfGuide = page.getByTestId('smart-folder-guide');
    await expect(sfGuide).toBeVisible();
    await expect(sfGuide).toContainText('スマートフォルダの使い方');
  },
);
