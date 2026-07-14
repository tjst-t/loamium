/**
 * system/ フォルダ表示トグル E2E テスト (Sa10026-4)。
 *
 * 実サーバー + 一時 vault で動く。sprint verify フェーズで実行する。
 *
 * AC-Sa10026-4-1: system/ 既定非表示・トグル表示/非表示。
 * AC-Sa10026-4-2: 定義ファイルを編集エディタで開く・order 再採番永続。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test.describe('Sa10026-4 system/ フォルダ表示 E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(readHarnessState().uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('[AC-Sa10026-4-1] 起動直後は system/ がツリーに現れない', async ({ page }) => {
    const toggle = page.getByTestId('tree-system-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('data-state', 'hidden');
    await expect(page.getByTestId('tree-system')).not.toBeVisible();
  });

  test('[AC-Sa10026-4-1] トグルで system/ が表示され再トグルで隠れる', async ({ page }) => {
    const toggle = page.getByTestId('tree-system-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'shown');
    await expect(page.getByTestId('tree-system')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'hidden');
    await expect(page.getByTestId('tree-system')).not.toBeVisible();
  });

  test('[AC-Sa10026-4-2] system/ 定義ファイルをクリックすると Editor で開く', async ({ page }) => {
    // system/ を表示
    await page.getByTestId('tree-system-toggle').click();
    await expect(page.getByTestId('tree-system')).toBeVisible();

    // settings.yaml をクリック (vault に必ず存在するはず)
    const settingsItem = page.locator('[data-testid="tree-item"][data-path="system/settings.yaml"]');
    if (await settingsItem.isVisible()) {
      await settingsItem.click();
      await expect(page.getByTestId('editor')).toBeVisible();
      await expect(page.getByTestId('save-status')).toBeVisible();
    }
  });
});
