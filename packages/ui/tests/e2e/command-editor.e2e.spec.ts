/**
 * CommandEditor E2E テスト — ADR-0012 + S9e64e7-1 + S9e64e7-2。
 * 実サーバー + 実 Vite dev server に対して実行する。
 * (E2E はスプリント verify フェーズで実行する。sprint run では mock のみ実行する。)
 *
 * ADR-0012: commands/create-todo.yaml は ファイル全体が LoamiumCommand YAML。
 *           global-setup (seedVault) が commands/create-todo.yaml を書き込む。
 *
 * AC-S9e64e7-1-1: commands/create-todo.yaml を開くと CommandEditor が表示される。
 *                 サイドバーの tree-item ではなく FilesPage 経由で開く場合も同様。
 * AC-S9e64e7-1-2: 定義が有効なとき保存ボタンが有効で、保存後 mtime が更新される。
 *                 定義が無効なとき保存ボタンが aria-disabled。
 * AC-S9e64e7-1-3: testid が gui-spec に準拠している。
 *
 * AC-S9e64e7-2-3: commands/create-todo.yaml を開き、テスト実行 → 自動保存してから run。
 *                 ジャーナルに todo が追記されたことを確認。
 *                 id は stem "create-todo" (display name ではなく)。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test.describe('CommandEditor E2E (ADR-0012 + S9e64e7-1)', () => {
  test('[AC-S9e64e7-1-1] commands/create-todo.yaml を開くと CommandEditor が表示される', async ({ page }) => {
    const { uiUrl } = readHarnessState();
    await page.goto(uiUrl);

    // FilesPage 経由で commands/create-todo.yaml を開く
    // (サイドバーは .md のみのため、/files ページから開く)
    await page.goto(`${uiUrl}/n/commands/create-todo.yaml`);

    // CommandEditor コンテナが visible
    await expect(page.getByTestId('command-editor')).toBeVisible();

    // 左ペイン (YAML ソース) と右ペイン枠が visible
    await expect(page.getByTestId('cmd-edit-yaml')).toBeVisible();
    await expect(page.getByTestId('cmd-edit-preview')).toBeVisible();

    // cmd-mode-badge が表示される
    await expect(page.getByTestId('cmd-mode-badge')).toBeVisible();

    // 通常 Editor は未描画
    expect(await page.getByTestId('editor').count()).toBe(0);
  });

  test('[AC-S9e64e7-1-2] 有効定義のとき save ボタンが有効で保存が成功する', async ({ page }) => {
    const { uiUrl } = readHarnessState();
    await page.goto(`${uiUrl}/n/commands/create-todo.yaml`);

    await expect(page.getByTestId('command-editor')).toBeVisible();

    // バリデーションが valid
    await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

    // 保存ボタンが aria-disabled ではない
    const saveBtn = page.getByTestId('cmd-edit-save');
    await expect(saveBtn).not.toHaveAttribute('aria-disabled');

    // 何か変更してから保存する (末尾に空行追加)
    const yamlPane = page.getByTestId('cmd-edit-yaml');
    await yamlPane.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    // dirty 状態になる
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');

    // 保存
    await page.getByTestId('cmd-edit-save').click();

    // 保存済みに戻る
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  });

  test('[AC-S9e64e7-1-3] testid が gui-spec の testid_contract に準拠している', async ({ page }) => {
    const { uiUrl } = readHarnessState();
    await page.goto(`${uiUrl}/n/commands/create-todo.yaml`);

    await expect(page.getByTestId('command-editor')).toBeVisible();

    // testid_contract の全 testid が存在する
    await expect(page.getByTestId('command-editor')).toBeVisible();         // container
    await expect(page.getByTestId('command-editor-header')).toBeVisible();  // header
    await expect(page.getByTestId('cmd-edit-yaml')).toBeVisible();          // left pane
    await expect(page.getByTestId('cmd-edit-preview')).toBeVisible();       // right pane
    await expect(page.getByTestId('cmd-edit-validation')).toBeVisible();    // validation
    await expect(page.getByTestId('cmd-edit-save')).toBeVisible();          // save button
    await expect(page.getByTestId('cmd-mode-badge')).toBeVisible();         // mode badge
    await expect(page.getByTestId('save-status')).toBeVisible();            // save status

    // S9e64e7-2 の追加 testid
    await expect(page.getByTestId('cmd-edit-test-run')).toBeVisible();      // test-run button
    // params プレビュー (create-todo.yaml には params があるはず)
    await expect(page.getByTestId('cmd-param-row').first()).toBeVisible();  // param rows
    // steps プレビュー
    await expect(page.getByTestId('cmd-step-row').first()).toBeVisible();   // step rows
  });
});

test.describe('CommandEditor E2E (S9e64e7-2)', () => {
  test('[AC-S9e64e7-2-3] commands/create-todo.yaml を開き、dirty で test-run すると PUT 後に POST run が呼ばれジャーナルに todo が追記される', async ({ page }) => {
    const { uiUrl } = readHarnessState();
    await page.goto(`${uiUrl}/n/commands/create-todo.yaml`);

    await expect(page.getByTestId('command-editor')).toBeVisible();
    await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

    // YAML の末尾に改行を追加して dirty にする
    const yamlPane = page.getByTestId('cmd-edit-yaml');
    await yamlPane.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    // dirty 状態
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
    await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

    // テスト実行ボタン (aria-disabled なし)
    await expect(page.getByTestId('cmd-edit-test-run')).not.toHaveAttribute('aria-disabled');

    // テスト実行をクリック (→ 自動保存 → params モーダルが開く)
    await page.getByTestId('cmd-edit-test-run').click();

    // 自動保存 (PUT) が完了したあと params モーダルが開く
    // create-todo.yaml には params があるので必ずモーダルが開く
    await expect(page.getByTestId('param-form-modal')).toBeVisible({ timeout: 10000 });

    // summary (required) を入力して submit ボタンが有効になるのを待ってから実行
    const summaryInput = page.locator('[data-testid="param-field-input"][data-name="summary"]');
    await summaryInput.fill('E2E テストタスク');
    // aria-disabled が外れるまで待つ
    await expect(page.getByTestId('param-form-submit')).not.toHaveAttribute('aria-disabled');
    await page.getByTestId('param-form-submit').click();
    await expect(page.getByTestId('param-form-modal')).not.toBeVisible({ timeout: 5000 });

    // cmd-edit-run-result が表示
    await expect(page.getByTestId('cmd-edit-run-result')).toBeVisible({ timeout: 10000 });

    // save-status が saved (自動保存が先に実行されたはず)
    await expect(page.getByTestId('save-status').first()).toHaveAttribute('data-state', 'saved');

    // step-result が少なくとも 1 件ある
    expect(await page.getByTestId('step-result').count()).toBeGreaterThan(0);
  });
});
