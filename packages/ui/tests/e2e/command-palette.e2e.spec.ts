/**
 * Story Sde7a63-1 e2e テスト — コマンドレジストリ + 組み込みコマンド (実サーバー)。
 * globalSetup が起動した実サーバー + Vite dev server に対して受け入れ条件を検証する。
 *
 * NOTE: このファイルは sprint run で書かれているが、実行は sprint verify フェーズ。
 *       `make test-ui` または `npx playwright test command-palette.e2e.spec.ts --project=e2e` で実行する。
 *
 * AC-Sde7a63-1-1: Ctrl-K からコマンドレジストリ経由で組み込みコマンドが起動できる。
 * AC-Sde7a63-1-2: パレットのコマンドセクション・キーボードナビが動作する。
 * AC-Sde7a63-1-3: 5 つの組み込みコマンドが実際のハンドラと接続されている。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

test.beforeEach(async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);
  // エディタが表示されるまで待つ (ジャーナルが開いている状態)
  await expect(page.locator('[data-testid="editor"]')).toBeVisible({ timeout: 15_000 });
});

// =========================================================================
// AC-Sde7a63-1-1: コマンドパレット基本構造 (実サーバー)
// =========================================================================

test('[AC-Sde7a63-1-1][E2E] Ctrl-K でコマンドパレットが開き search-input にフォーカスが当たる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('command-palette')).toHaveAttribute('role', 'dialog');
  await expect(page.getByTestId('command-palette')).toHaveAttribute('aria-label', 'コマンドパレット');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', '検索またはコマンドを入力…');
});

test('[AC-Sde7a63-1-1][E2E] 空クエリでコマンドセクションが表示される', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();
  // S6848dc-6: リスト変換コマンド 2 件を追加し 5→7 件。
  await expect(page.locator('[data-testid="command-item"][data-source="builtin"]')).toHaveCount(7);
});

// =========================================================================
// AC-Sde7a63-1-2: クエリ絞り込みとキーボードナビ (実サーバー)
// =========================================================================

test('[AC-Sde7a63-1-2][E2E] "ジャーナル" でコマンドを絞り込むと open-today-journal だけ表示される', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').type('ジャーナル');

  await expect(page.locator('[data-testid="command-item"][data-command-id="open-today-journal"]')).toBeVisible();
  await expect(page.locator('[data-testid="command-item"]')).toHaveCount(1);
});

test('[AC-Sde7a63-1-2][E2E] ↓↑ キーで command-item を移動できる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  // コマンドが非同期で読み込まれるのを待つ (空クエリ → コマンドセクションのみ表示)
  const firstItem = page.locator('[data-testid="command-item"]').first();
  // 初期状態: selected=0 のため先頭アイテムが pre-selected になる
  await expect(firstItem).toHaveAttribute('aria-selected', 'true');
  // ArrowDown で 2 番目へ移動
  await page.keyboard.press('ArrowDown');
  const secondItem = page.locator('[data-testid="command-item"]').nth(1);
  await expect(secondItem).toHaveAttribute('aria-selected', 'true');
  // ArrowDown でさらに 3 番目へ
  await page.keyboard.press('ArrowDown');
  const thirdItem = page.locator('[data-testid="command-item"]').nth(2);
  await expect(thirdItem).toHaveAttribute('aria-selected', 'true');
  // ArrowUp で 2 番目へ戻る
  await page.keyboard.press('ArrowUp');
  await expect(secondItem).toHaveAttribute('aria-selected', 'true');
});

test('[AC-Sde7a63-1-2][E2E] Esc でパレットが閉じる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

// =========================================================================
// AC-Sde7a63-1-3: 組み込みコマンドが既存ハンドラへ接続 (実サーバー)
// =========================================================================

test('[AC-Sde7a63-1-3][E2E] new-note コマンドをクリックすると新規ノートダイアログが開く', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="new-note"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
});

test('[AC-Sde7a63-1-3][E2E] open-advanced-search コマンドをクリックすると /search ルートへ遷移する', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="open-advanced-search"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('route-display')).toContainText('/search');
});

test('[AC-Sde7a63-1-3][E2E] open-today-journal コマンドをクリックするとジャーナルに遷移する', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="open-today-journal"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // journals/ パスがルート表示に現れる
  await expect(page.getByTestId('route-display')).toContainText('journals');
});

test('[AC-Sde7a63-1-3][E2E] new-note-from-template コマンドをクリックするとテンプレートピッカーが開く', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="new-note-from-template"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // テンプレートピッカーが開く (空の場合もダイアログが表示される)
  await expect(page.getByTestId('template-picker')).toBeVisible();
});

test('[AC-Sde7a63-1-3][E2E] new-smart-folder コマンドをクリックするとスマートビューに切り替わる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="command-item"][data-command-id="new-smart-folder"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // スマートビューへの切り替え
  await expect(page.getByTestId('sidebar-view-smart')).toHaveAttribute('aria-pressed', 'true');
});

// =========================================================================
// AC-Sde7a63-2-1 / AC-Sde7a63-2-2: '>' コマンド専用モード (Story Sde7a63-2)
// NOTE: このセクションは sprint run で書かれたが実行は sprint verify フェーズ。
// =========================================================================

test('[AC-Sde7a63-2-1][E2E] 先頭 > でコマンド専用モードになりノート/全文セクションが非表示', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('>');

  // コマンドモードインジケーター表示
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // ノート/全文セクションは非表示
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);

  // コマンドセクションは表示
  await expect(page.getByTestId('palette-section-commands')).toBeVisible();
});

test('[AC-Sde7a63-2-1][E2E] > journal でコマンドのみ絞り込まれる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('> journal');

  await expect(page.getByTestId('palette-mode-command')).toBeVisible();
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="open-today-journal"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="command-item"]')).toHaveCount(1);
});

test('[AC-Sde7a63-2-1][E2E] > を削除すると通常モードに戻る', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // '>' を削除
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('palette-mode-command')).toHaveCount(0);
});

test('[AC-Sde7a63-2-2][E2E] コマンドモード中の placeholder が変わる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('search-input')).toHaveAttribute(
    'placeholder',
    '検索またはコマンドを入力…',
  );

  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'コマンドを入力…');
});

test('[AC-Sde7a63-2-2][E2E] コマンドモード中の Esc でパレットが閉じる', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

test('[AC-Sde7a63-2-2][E2E] コマンドモード中の ↑↓ ナビゲーション', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  const firstItem = page.locator('[data-testid="command-item"]').first();
  await expect(firstItem).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowDown');
  const secondItem = page.locator('[data-testid="command-item"]').nth(1);
  await expect(secondItem).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowUp');
  await expect(firstItem).toHaveAttribute('aria-selected', 'true');
});

test('[AC-Sde7a63-2-2][E2E] コマンドモード中の Enter でコマンド実行', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('>');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // 先頭 (new-note) が選択された状態で Enter
  await expect(
    page.locator('[data-testid="command-item"]').first(),
  ).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
});
