/**
 * 同期セットアップウィザード e2e テスト (Sf17a4c-5) — 実バックエンド使用。
 *
 * モックなし。実際の POST /api/sync/link/preview に対してネットワーク観察を行う。
 * ハーネス vault はシンプルで実際のリモートは存在しないため、preview は
 * remoteState:'unreachable' または plan:'noop' を返すことがある。
 * ここではウィザードの描画・リンク開始の round-trip が crash-free であることを確認する。
 *
 * [AC-Sf17a4c-5-1] 実 POST /api/sync/link/preview が呼ばれ、レスポンスを返す (クラッシュなし)。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test('[AC-Sf17a4c-5-1] ウィザードが表示され sync-setup-start が実際の preview エンドポイントを呼ぶ', async ({ page }) => {
  const state = readHarnessState();

  // POST /api/sync/link/preview を observe (モックしない)
  const previewRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/sync/link/preview') && req.method() === 'POST') {
      previewRequests.push(req.url());
    }
  });

  await page.goto(`${state.uiUrl}/settings/sync`);

  // 同期パネルが表示される
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible({ timeout: 10000 });

  // ウィザードを開く (sync-open-wizard = SettingsView の「同期をセットアップ」ボタン)
  await page.getByTestId('sync-open-wizard').click();
  await expect(page.getByTestId('sync-setup-wizard')).toBeVisible({ timeout: 5000 });

  // URL を入力してリンク開始
  const testRemoteUrl = 'https://github.com/loamium-test/nonexistent-vault.git';
  await page.getByTestId('sync-setup-remote-url').fill(testRemoteUrl);

  // リンク開始ボタン (wizard 内の sync-setup-start)
  const startBtn = page.getByTestId('sync-setup-wizard').getByTestId('sync-setup-start');
  await expect(startBtn).toBeEnabled();
  await startBtn.click();

  // 実 API が呼ばれるのを待つ (タイムアウト内にリクエストが飛べば OK)
  await page.waitForTimeout(5000);

  // preview リクエストが送信された
  expect(previewRequests.length).toBeGreaterThan(0);

  // ウィザードまたはエラー表示 (リモート未到達でもクラッシュしない)
  // 完了ダイアログ or エラー or 競合ダイアログのいずれかが表示されているか、
  // またはウィザードが引き続き表示されている (エラー状態含む)
  const wizardVisible = await page.getByTestId('sync-setup-wizard').isVisible();
  const doneVisible = await page.getByTestId('link-done-dialog').isVisible();
  const conflictVisible = await page.getByTestId('link-conflict-dialog').isVisible();
  expect(wizardVisible || doneVisible || conflictVisible).toBe(true);
});
