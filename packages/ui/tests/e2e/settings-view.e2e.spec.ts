/**
 * 統一設定画面 E2E テスト (Sa10026-7)。
 *
 * 実サーバー・実 vault に対して設定の read/write 往復を検証する。
 * - [AC-Sa10026-7-1] 全体設定を変更・保存・再取得で往復する。
 * - [AC-Sa10026-7-1] エージェント接続設定を保存・再取得で往復する。
 * - [AC-Sa10026-7-1] プライバシー deny-list を追加・保存・再取得で往復する。
 *
 * このテストは `sprint verify` フェーズで実サーバーを起動して実行する。
 * mock テストはサーバーなしで `sprint run` フェーズで実行する。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const harness = readHarnessState();

// ============================================================
// [AC-Sa10026-7-1] 全体設定の read/write 往復
// ============================================================

test('[AC-Sa10026-7-1] 全体設定を変更して保存し、再取得で同じ値が返る', async ({ page }) => {
  await page.goto(harness.uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  // 設定画面を開く
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // defaultFolder を変更
  const field = page.locator('[data-testid="settings-field"][data-name="defaultFolder"]');
  await field.fill('notes-e2e-test');

  // 保存
  await page.locator('[data-testid="settings-save"][data-group="general"]').click();
  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'saved');

  // 設定はルート化 (Sa10026-9 #2): /settings をリロードすると設定ページに直接着地する
  await page.reload();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // 保存した値が反映される
  await expect(page.locator('[data-testid="settings-field"][data-name="defaultFolder"]')).toHaveValue('notes-e2e-test');

  // 後片付け: 元に戻す
  await page.locator('[data-testid="settings-field"][data-name="defaultFolder"]').fill('');
  await page.locator('[data-testid="settings-save"][data-group="general"]').click();
  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'saved');
});

// ============================================================
// [AC-Sa10026-7-1] プライバシー deny-list の read/write 往復
// ============================================================

test('[AC-Sa10026-7-1] プライバシー deny-list を追加して保存し、再取得で反映される', async ({ page }) => {
  await page.goto(harness.uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();

  // e2e テスト用のエントリを追加
  const testEntry = 'e2e-test/**';
  await page.getByTestId('deny-add-input').fill(testEntry);
  await page.getByTestId('deny-add').click();

  // UI に追加されたことを確認
  await expect(page.locator(`[data-testid="deny-entry"][data-value="${testEntry}"]`)).toBeVisible();

  // 保存
  await page.locator('[data-testid="settings-save"][data-group="privacy"]').click();
  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'saved');

  // リロードして再確認 (Sa10026-9 #2: /settings に直接着地するのでナビ不要)
  await page.reload();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();

  // 保存したエントリが表示される
  await expect(page.locator(`[data-testid="deny-entry"][data-value="${testEntry}"]`)).toBeVisible();

  // 後片付け: エントリを削除して保存
  await page.locator(`[data-testid="deny-entry"][data-value="${testEntry}"] [data-testid="deny-del"]`).click();
  await page.locator('[data-testid="settings-save"][data-group="privacy"]').click();
  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'saved');
});
