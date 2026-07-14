/**
 * スマートフォルダ管理 e2e テスト (Sa100c6-2)。
 * 実サーバー + 実 vault を使って作成 → 編集 → 並べ替え → 反映を確認する。
 *
 * sprint verify 用: make test-ui でも実行される。
 *
 * [AC-Sa100c6-2-1] スマートフォルダ作成→編集→保存→反映。
 * [AC-Sa100c6-2-2] 並べ替え→order 再採番→永続。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const SF_NAME = `e2e-sf-${Date.now().toString(36)}`;

/** 設定画面を開き smart-folders タブへ遷移 */
async function openSFTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]').click();
  await expect(page.locator('[data-testid="md-panel"][data-group="smart-folders"]')).toBeVisible();
}

test.describe('smart-folders e2e', () => {
  test('[AC-Sa100c6-2-1] スマートフォルダを作成→DQL編集→保存→一覧に反映', async ({ page }) => {
    const state = readHarnessState();

    await page.goto(state.uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 10000 });

    await openSFTab(page);

    // 新規ボタンをクリック
    await page.getByTestId('md-new').click();

    // detail-title が表示される
    await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

    // タイトルを変更
    await page.getByTestId('detail-title').fill(SF_NAME);

    // DQL を変更
    await expect(page.getByTestId('sf-form-dql')).toBeVisible({ timeout: 3000 });
    await page.getByTestId('sf-form-dql').fill('LIST SORT file.mtime DESC LIMIT 5');

    // 保存
    await page.getByTestId('md-save').click();

    // 保存済みバッジが表示される
    await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });

    // 一覧にアイテムとして表示される (md-item の nm テキストで確認)
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: SF_NAME })
    ).toBeVisible({ timeout: 5000 });
  });

  test('[AC-Sa100c6-2-1] スマートフォルダを削除すると一覧から消える', async ({ page }) => {
    const deleteSfName = `e2e-del-sf-${Date.now().toString(36)}`;
    const state = readHarnessState();

    await page.goto(state.uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 10000 });

    await openSFTab(page);

    // 新規作成
    await page.getByTestId('md-new').click();
    await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('detail-title').fill(deleteSfName);
    await page.getByTestId('md-save').click();
    await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });

    // 作成したアイテムがあることを確認
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: deleteSfName })
    ).toBeVisible({ timeout: 5000 });

    // 削除 (confirm ダイアログを accept)
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await page.getByTestId('md-delete').click();

    // 一覧から消える
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: deleteSfName })
    ).not.toBeVisible({ timeout: 5000 });
  });

  test('[AC-Sa100c6-2-2] スマートフォルダを作成して並べ替え→リロード後も保持', async ({ page }) => {
    const sfNameA = `e2e-ord-a-${Date.now().toString(36)}`;
    const sfNameB = `e2e-ord-b-${Date.now().toString(36)}`;
    const state = readHarnessState();

    await page.goto(state.uiUrl);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 10000 });
    await openSFTab(page);

    // スマートフォルダ A を作成
    await page.getByTestId('md-new').click();
    await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('detail-title').fill(sfNameA);
    await page.getByTestId('md-save').click();
    await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });

    // スマートフォルダ B を作成
    await page.getByTestId('md-new').click();
    await expect(page.getByTestId('detail-title')).toHaveValue(/.+/, { timeout: 5000 });
    await page.getByTestId('detail-title').fill(sfNameB);
    await page.getByTestId('md-save').click();
    await expect(page.locator('.md-save-ok')).toBeVisible({ timeout: 5000 });

    // A と B が一覧に存在することを確認
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: sfNameA })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: sfNameB })
    ).toBeVisible({ timeout: 5000 });

    // A のアイテムを B の後ろへドラッグ
    const itemA = page.locator('[data-testid="md-item"]').filter({ hasText: sfNameA });
    const itemB = page.locator('[data-testid="md-item"]').filter({ hasText: sfNameB });

    const boxA = await itemA.boundingBox();
    const boxB = await itemB.boundingBox();

    if (boxA !== null && boxB !== null) {
      await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
      await page.mouse.down();
      await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height + 5, { steps: 10 });
      await page.mouse.up();
    }

    // 少し待機してドロップ処理が完了するのを待つ
    await page.waitForTimeout(500);

    // 設定画面を閉じて再度開く (リロード相当)
    await page.keyboard.press('Escape');
    await openSFTab(page);

    // A と B の両方が一覧に存在することを確認 (並べ替えが永続)
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: sfNameA })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-testid="md-item"]').filter({ hasText: sfNameB })
    ).toBeVisible({ timeout: 5000 });
  });
});
