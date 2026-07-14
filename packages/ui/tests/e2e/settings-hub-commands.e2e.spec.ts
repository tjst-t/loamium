/**
 * 設定ハブ スマートコマンド管理 E2E テスト (Sa100c6-3)。
 *
 * 実サーバー + 実 vault で動作を検証する。
 * make serve が起動済み、portman でポートを取得し、実際に API を叩く。
 *
 * [AC-Sa100c6-3-1] 作成→編集→保存→反映の実機 E2E。
 * [AC-Sa100c6-3-2] 試し実行で実際に POST /api/commands/{id}/run を叩き結果を確認。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const STEM = `e2e-cmd-${Date.now().toString(36)}`;
const CMD_YAML = `name: E2E テストコマンド
description: E2E テスト用
steps:
  - kind: journal-append
    content: E2E テスト追記
`;

/** 設定画面を開き commands タブへ遷移 */
async function openCommandsTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="commands"]').click();
  await expect(page.locator('[data-testid="md-panel"][data-group="commands"]')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  // コマンドを事前作成
  const { apiUrl } = readHarnessState();
  const res = await request.put(`${apiUrl}/api/commands/${STEM}/source`, {
    data: { content: CMD_YAML },
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok()) {
    throw new Error(`Failed to create test command: ${String(res.status())}`);
  }
});

test.afterEach(async ({ request }) => {
  // コマンドを後片付け
  const { apiUrl } = readHarnessState();
  await request.delete(`${apiUrl}/api/system-files/${encodeURIComponent(`system/commands/${STEM}.yaml`)}/source`);
});

test('[AC-Sa100c6-3-1] コマンド管理: 作成済みコマンドが一覧に表示される', async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await openCommandsTab(page);

  // STEM が一覧に表示される
  await expect(page.locator(`[data-testid="md-item"][data-id="${STEM}"]`)).toBeVisible({ timeout: 5000 });
});

test('[AC-Sa100c6-3-1] コマンド管理: 選択して編集・保存できる', async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await openCommandsTab(page);

  // STEM を選択
  await page.locator(`[data-testid="md-item"][data-id="${STEM}"]`).click();
  await expect(page.getByTestId('detail-title')).toHaveValue('E2E テストコマンド', { timeout: 5000 });

  // 説明を変更
  await page.getByTestId('cmd-description').fill('E2E テスト用 — 更新済み');

  // 保存
  await page.getByTestId('md-save').click();

  // 保存済み表示
  await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });
});

test('[AC-Sa100c6-3-1] コマンド管理: step を追加して保存できる', async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await openCommandsTab(page);

  await page.locator(`[data-testid="md-item"][data-id="${STEM}"]`).click();
  await expect(page.getByTestId('cmd-step-add')).toBeVisible({ timeout: 5000 });

  // step 追加
  await page.getByTestId('cmd-step-add').click();
  await expect(page.getByTestId('step-edit-modal')).toBeVisible();

  // note-append を選択
  await page.getByTestId('step-edit-kind').selectOption('note-append');
  await page.getByTestId('step-edit-target').fill('notes/e2e-test.md');
  await page.getByTestId('step-edit-content').fill('E2E 追記');
  await page.getByTestId('step-edit-save').click();

  // step 行が追加される
  await expect(page.locator('[data-testid="cmd-step-row"][data-kind="note-append"]')).toBeVisible();

  // 保存
  await page.getByTestId('md-save').click();
  await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });
});

test('[AC-Sa100c6-3-2] 試し実行: POST /api/commands/{id}/run の結果が表示される', async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await openCommandsTab(page);

  await page.locator(`[data-testid="md-item"][data-id="${STEM}"]`).click();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible({ timeout: 5000 });

  // 試し実行 (param なし)
  await page.getByTestId('cmd-test-run').click();

  // 結果が表示される
  await expect(page.getByTestId('cmd-run-result')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('cmd-run-result-status')).toBeVisible();
});
