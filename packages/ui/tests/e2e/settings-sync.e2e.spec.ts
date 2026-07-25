/**
 * 同期設定 GUI e2e テスト (Se29635-6) — 実バックエンド使用。
 *
 * 実際の GET /api/sync/config / PUT /api/sync/config をテストする。
 * モックなし。
 *
 * [AC-Se29635-6-1] 実 GET config でセクションが表示され、編集・保存が実際の PUT と round-trip する。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test('[AC-Se29635-6-1] 実バックエンドで同期セクションが表示され remoteUrl が round-trip する', async ({ page }) => {
  const state = readHarnessState();

  await page.goto(`${state.uiUrl}/settings/sync`);

  // 同期パネルが表示される
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible({ timeout: 10000 });

  // remoteUrl フィールドに値を設定して保存
  const testUrl = 'https://github.com/e2e-test/vault.git';
  await page.getByTestId('settings-sync-remote-url').fill(testUrl);
  await page.getByTestId('settings-sync-save').click();

  // 保存成功フィードバック
  await expect(page.locator('[data-testid="settings-status"][data-state="saved"]').first()).toBeVisible({ timeout: 5000 });

  // ページを /settings/sync に再移動して値が保持されていることを確認
  await page.goto(`${state.uiUrl}/settings/sync`);
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('settings-sync-remote-url')).toHaveValue(testUrl, { timeout: 5000 });

  // クリーンアップ: remoteUrl を空に戻す
  await page.getByTestId('settings-sync-remote-url').fill('');
  await page.getByTestId('settings-sync-save').click();
  await expect(page.locator('[data-testid="settings-status"][data-state="saved"]').first()).toBeVisible({ timeout: 5000 });
});
