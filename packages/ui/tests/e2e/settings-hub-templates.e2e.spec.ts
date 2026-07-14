/**
 * テンプレート管理 e2e テスト (Sa100c6-1)。
 * 実サーバー + 実 vault を使って作成 → 編集 → 保存 → 反映を確認する。
 *
 * sprint verify 用: make test-ui でも実行される。
 *
 * [AC-Sa100c6-1-2] テンプレ作成→編集→保存→反映。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const TEMPLATE_NAME = `e2e-tmpl-${Date.now().toString(36)}`;

test.describe('templates e2e', () => {
  test('[AC-Sa100c6-1-2] テンプレートを作成→タイトル編集→保存→一覧に反映', async ({ page }) => {
    const state = readHarnessState();

    // app 起動
    await page.goto(state.uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 10000 });

    // 設定画面を開く
    await page.getByTestId('sidebar-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();

    // テンプレートタブへ
    await page.locator('[data-testid="settings-nav-item"][data-group="templates"]').click();
    await expect(page.locator('[data-testid="md-panel"][data-group="templates"]')).toBeVisible();

    // 新規ボタンをクリック
    await page.getByTestId('md-new').click();

    // detail-title が表示される
    await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

    // 新しいタイトルを入力
    await page.getByTestId('detail-title').fill(TEMPLATE_NAME);

    // 保存
    await page.getByTestId('md-save').click();

    // md-save-ok が表示される
    await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });

    // 一覧にアイテムとして表示される
    await expect(
      page.locator(`[data-testid="md-item"][data-id="${TEMPLATE_NAME}"]`)
    ).toBeVisible({ timeout: 5000 });
  });

  test('[AC-Sa100c6-1-2] テンプレートを削除すると一覧から消える', async ({ page }) => {
    const deleteTemplateName = `e2e-del-${Date.now().toString(36)}`;
    const state = readHarnessState();

    await page.goto(state.uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('sidebar-settings').click();
    await page.locator('[data-testid="settings-nav-item"][data-group="templates"]').click();
    await expect(page.locator('[data-testid="md-panel"][data-group="templates"]')).toBeVisible();

    // 新規作成
    await page.getByTestId('md-new').click();
    await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('detail-title').fill(deleteTemplateName);
    await page.getByTestId('md-save').click();
    await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });

    // 作成したアイテムを選択して削除
    await page.locator(`[data-testid="md-item"][data-id="${deleteTemplateName}"]`).click();
    await expect(page.getByTestId('detail-title')).toHaveValue(deleteTemplateName, { timeout: 3000 });

    // 削除 (confirm ダイアログを accept)
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.getByTestId('md-delete').click();

    // 一覧から消える
    await expect(
      page.locator(`[data-testid="md-item"][data-id="${deleteTemplateName}"]`)
    ).not.toBeVisible({ timeout: 5000 });
  });
});
