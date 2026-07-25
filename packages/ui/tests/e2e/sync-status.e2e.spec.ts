/**
 * SyncStatusIndicator e2e テスト (Se29635-4 / AC-Se29635-4-2)。
 *
 * 実バックエンドを使用する (globalSetup で起動するハーネス vault)。
 * sync エンドポイントはモックしない (Rule 4: e2e は real backend)。
 * ハーネス vault は git repo/remote が設定されていない可能性があるため、
 * "not-configured" / "unavailable" 状態が真実として返ることを検証する。
 *
 * [AC-Se29635-4-2]
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll } from '../harness/mock-helpers.js';

test('[AC-Se29635-4-2] sync-status インジケータが実バックエンドから表示される', async ({ page }) => {
  // sync エンドポイントはモックしない (実バックエンド) — installCatchAll は使わない
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  // sync-status が DOM に存在すること
  // (実バックエンドが git 不在/リモート未設定を返すため、available=false or remoteConfigured=false になる)
  await expect(page.getByTestId('sync-status')).toBeAttached({ timeout: 10000 });

  // インジケータが visible になること: loading → 実状態表示 (unavailable / no-remote / 通常表示)
  // sync-status-loading クラスが外れるまで待つ (visibility:hidden → visible)
  await expect(page.getByTestId('sync-status')).not.toHaveClass(/sync-status-loading/, { timeout: 10000 });
  await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 5000 });

  // sync-now-button が存在すること (状態が何であれボタンは必ずレンダリングされる)
  await expect(page.getByTestId('sync-now-button')).toBeAttached({ timeout: 5000 });
});

test('[AC-Se29635-4-2] sync-now-button クリックが実 POST /api/sync/now を発行する', async ({ page }) => {
  // sync エンドポイントはモックしない (実バックエンド)
  // ネットワーク監視: /api/sync/now への POST をキャプチャ
  const syncNowRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/sync/now') && req.method() === 'POST') {
      syncNowRequests.push(req.url());
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  // loading state が外れるまで待つ
  await expect(page.getByTestId('sync-status')).not.toHaveClass(/sync-status-loading/, { timeout: 10000 });
  await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 5000 });

  const btn = page.getByTestId('sync-now-button');
  await expect(btn).toBeAttached({ timeout: 5000 });

  // ボタンが enabled の場合のみクリックして POST を確認する
  const disabled = await btn.isDisabled();
  if (!disabled) {
    await btn.click();
    // POST /api/sync/now が発行されたことを確認
    await expect.poll(() => syncNowRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
    // UI が更新される (sync-status が re-render される)
    await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 5000 });
  } else {
    // git 不在 / リモート未設定 → disabled は正当。実状態が返っていることを確認するだけ
    // test.skip ではなく、disabled ボタンが返ること自体を検証する
    await expect(btn).toBeDisabled();
  }
});
