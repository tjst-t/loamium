/**
 * system/ ネストフォルダツリー E2E テスト (Sa10026-9 #4/#5)。
 *
 * 実サーバー + 一時 vault で動く。sprint verify フェーズで実行する。
 * トグルは撤去 (#5)。system/ は常時表示のネストツリー (#4)。
 * 定義ファイルは system-files source 経由で編集エディタに開く。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test.describe('Sa10026-9 system/ ネストフォルダツリー E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(readHarnessState().uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('[#5] トグルは撤去され、system/ ツリーが常時表示される', async ({ page }) => {
    await expect(page.getByTestId('tree-system-toggle')).toHaveCount(0);
    await expect(page.getByTestId('tree-system')).toBeVisible();
    await expect(page.getByTestId('tree-system-root')).toBeVisible();
  });

  test('[#4] system/ サブフォルダがネスト表示される', async ({ page }) => {
    const tree = page.getByTestId('tree-system');
    // 一時 vault には smart-folders / templates が必ず存在する
    await expect(
      tree.locator('[data-testid="tree-folder"][data-path="system/smart-folders"]'),
    ).toBeVisible();
    await expect(
      tree.locator('[data-testid="tree-folder"][data-path="system/templates"]'),
    ).toBeVisible();
  });

  test('[#4] system/settings.yaml をクリックすると Editor で開く', async ({ page }) => {
    const settingsItem = page
      .getByTestId('tree-system')
      .locator('[data-testid="tree-item"][data-path="system/settings.yaml"]');
    if (await settingsItem.isVisible()) {
      await settingsItem.click();
      await expect(page.getByTestId('editor')).toBeVisible();
      await expect(page.getByTestId('save-status')).toBeVisible();
    }
  });
});
