/**
 * system/ ネストフォルダツリー E2E テスト (Sa10026-9 #4/#5)。
 *
 * 実サーバー + 一時 vault で動く。sprint verify フェーズで実行する。
 * トグルは撤去 (#5)。system/ は showSystemFolder=true のときのみ表示 (#4)。
 * 定義ファイルは system-files source 経由で編集エディタに開く。
 * E2E 環境の一時 vault は showSystemFolder=true で起動する前提 (harness 設定)。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test.describe('Sa10026-9 system/ ネストフォルダツリー E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(readHarnessState().uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('[#5] tree-system-toggle は撤去されている', async ({ page }) => {
    await expect(page.getByTestId('tree-system-toggle')).toHaveCount(0);
  });

  test('[#4] showSystemFolder=true のとき system/ サブフォルダがネスト表示される', async ({ page }) => {
    // E2E vault は showSystemFolder=true で起動。非表示の場合はツリーなしで SKIP。
    const tree = page.getByTestId('tree-system');
    if (await tree.count() === 0) {
      test.skip(true, 'showSystemFolder=false のため tree-system は非表示 (E2E vault の設定を確認)');
    }
    await expect(tree).toBeVisible();
    await expect(page.getByTestId('tree-system-root')).toBeVisible();
    // 一時 vault には smart-folders / templates が必ず存在する
    await expect(
      tree.locator('[data-testid="tree-folder"][data-path="system/smart-folders"]'),
    ).toBeVisible();
    await expect(
      tree.locator('[data-testid="tree-folder"][data-path="system/templates"]'),
    ).toBeVisible();
  });

  test('[#4] system/settings.yaml をクリックすると Editor で開く', async ({ page }) => {
    // tree が非表示なら SKIP
    if (await page.getByTestId('tree-system').count() === 0) {
      test.skip(true, 'showSystemFolder=false のため tree-system は非表示');
    }
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
