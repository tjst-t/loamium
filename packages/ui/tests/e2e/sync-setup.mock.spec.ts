/**
 * 同期セットアップウィザード + 初回リンク競合ダイアログ mock テスト (Sf17a4c-5)。
 *
 * page.route で API をモックし、ブラウザ上の GUI 動作を検証する。サーバーは起動しない。
 *
 * [AC-Sf17a4c-5-1] 衝突0件: ウィザード → preview → 自動 apply → 完了ダイアログ
 * [AC-Sf17a4c-5-2] 衝突あり: ウィザード → preview → 競合ダイアログ → 解決 → apply → 完了ダイアログ
 * [AC-Sf17a4c-5-2] mobile: ≤680px でダイアログ + スイッチが利用可能
 *
 * 注意: installCatchAll が /api/sync/link/status のデフォルトスタブを含む。
 * 各テストは boot() 後に link/preview / link/apply を独自ルートで登録する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-26';
const JOURNAL_PATH = `journals/${DATE}.md`;
const NOTES = [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals', mtime: 1000 }];

function journalResponse(): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content: '',
    frontmatter: null,
    body: '',
    created: false,
    mtime: 1000,
  };
}

/** 衝突 0 件の preview レスポンス */
function previewNoConflicts(): Record<string, unknown> {
  return {
    remoteState: 'non-empty',
    local: { hasData: true, fileCount: 3 },
    plan: 'merge',
    counts: { addedFromRemote: 5, addedFromLocal: 3, conflicts: 0 },
    conflicts: [],
    warnings: [],
    nameCollisions: [],
  };
}

/** 衝突 2 件の preview レスポンス */
function previewWithConflicts(): Record<string, unknown> {
  return {
    remoteState: 'non-empty',
    local: { hasData: true, fileCount: 5 },
    plan: 'merge',
    counts: { addedFromRemote: 4, addedFromLocal: 3, conflicts: 2 },
    conflicts: [
      { file: 'notes/alpha.md' },
      { file: 'notes/beta.md' },
    ],
    warnings: [],
    nameCollisions: [],
  };
}

/** apply 成功レスポンス */
function applySuccess(addedFromRemote = 5, addedFromLocal = 3, conflictsResolved = 0): Record<string, unknown> {
  return {
    ok: true,
    pushed: true,
    backupRef: 'backup/pre-link-20260726',
    summary: {
      plan: 'merge',
      pushed: true,
      addedFromRemote,
      addedFromLocal,
      conflictsResolved,
    },
  };
}

/** アプリを起動してジャーナルが開いた状態にする。 */
async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  return unexpected;
}

/** 設定を開いて同期タブに移動する。 */
async function openSyncSettings(page: Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="sync"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible();
}

/** 同期設定パネルの「同期をセットアップ」ボタンをクリックしてウィザードを開く。 */
async function openWizard(page: Page): Promise<void> {
  await openSyncSettings(page);
  // sync-open-wizard = SettingsView 側のボタン (wizard 内の sync-setup-start とは別)
  await page.getByTestId('sync-open-wizard').click();
  await expect(page.getByTestId('sync-setup-wizard')).toBeVisible();
}

// ============================================================
// [AC-Sf17a4c-5-1] 衝突0件: 自動 apply → 完了ダイアログ
// ============================================================

test('[AC-Sf17a4c-5-1] 衝突0件のとき自動適用され完了ダイアログが表示される', async ({ page }) => {
  const capturedApplyBodies: unknown[] = [];

  await boot(page);

  // preview → 衝突 0 件
  await page.route('**/api/sync/link/preview', (route) => {
    void route.fulfill(json(previewNoConflicts()));
  });

  // apply を capture
  await page.route('**/api/sync/link/apply', (route) => {
    const body: unknown = route.request().postDataJSON();
    capturedApplyBodies.push(body);
    void route.fulfill(json(applySuccess(5, 3, 0)));
  });

  await openWizard(page);

  // URL 入力
  await page.getByTestId('sync-setup-remote-url').fill('https://github.com/test/vault.git');
  // リンク開始 (wizard 内の sync-setup-start)
  await page.getByTestId('sync-setup-wizard').getByTestId('sync-setup-start').click();

  // 自動 apply 後、完了ダイアログ表示
  await expect(page.getByTestId('link-done-dialog')).toBeVisible({ timeout: 8000 });
  const summary = page.getByTestId('link-done-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('5');
  await expect(summary).toContainText('3');

  // apply が呼ばれた (resolutions 空)
  expect(capturedApplyBodies.length).toBeGreaterThan(0);
  const applyBody = capturedApplyBodies[0] as Record<string, unknown>;
  expect(applyBody).toHaveProperty('remoteUrl', 'https://github.com/test/vault.git');
  expect(applyBody).toHaveProperty('resolutions');
  expect((applyBody['resolutions'] as unknown[]).length).toBe(0);
});

// ============================================================
// [AC-Sf17a4c-5-2] 衝突あり: 競合ダイアログ → 解決 → apply
// ============================================================

test('[AC-Sf17a4c-5-2] 衝突ありのとき競合ダイアログが表示され、モードラジオとスイッチが機能する', async ({ page }) => {
  const capturedApplyBodies: unknown[] = [];

  await boot(page);

  await page.route('**/api/sync/link/preview', (route) => {
    void route.fulfill(json(previewWithConflicts()));
  });
  await page.route('**/api/sync/link/apply', (route) => {
    const body: unknown = route.request().postDataJSON();
    capturedApplyBodies.push(body);
    void route.fulfill(json(applySuccess(4, 3, 2)));
  });

  await openWizard(page);
  await page.getByTestId('sync-setup-remote-url').fill('https://github.com/test/vault.git');
  await page.getByTestId('sync-setup-wizard').getByTestId('sync-setup-start').click();

  // 競合ダイアログが出る
  await expect(page.getByTestId('link-conflict-dialog')).toBeVisible({ timeout: 8000 });

  // モードラジオ確認
  const perfileRadio = page.getByTestId('link-conflict-mode-perfile');
  const allRadio = page.getByTestId('link-conflict-mode-all');
  await expect(perfileRadio).toBeVisible();
  await expect(allRadio).toBeVisible();
  // ファイルごとがデフォルト
  await expect(perfileRadio).toBeChecked();

  // セグメントスイッチが存在する (競合ダイアログ内に <select> は存在しない)
  const conflictDialog = page.getByTestId('link-conflict-dialog');
  const selects = await conflictDialog.locator('select').count();
  expect(selects).toBe(0);
  const switches = page.getByTestId('link-conflict-switch');
  expect(await switches.count()).toBeGreaterThan(0);

  // デフォルト = 両方保持 (aria-pressed="true" on keep-both buttons)
  const keepBothPressedButtons = page.locator('[data-testid="link-conflict-switch"][data-action="keep-both"][aria-pressed="true"]');
  expect(await keepBothPressedButtons.count()).toBeGreaterThan(0);

  // 全件モードに切り替え → 上部スイッチが表示される
  await allRadio.click();
  await expect(page.getByTestId('link-conflict-apply-all')).toBeVisible();

  // ローカル採用スイッチを選ぶ (全件モードのため全ファイルに適用)
  await page.locator('[data-testid="link-conflict-apply-all"] [data-testid="link-conflict-switch"][data-action="local"]').click();

  // 確定
  await page.getByTestId('link-conflict-confirm').click();

  // apply が呼ばれ resolutions が all local
  await expect(page.getByTestId('link-done-dialog')).toBeVisible({ timeout: 8000 });
  expect(capturedApplyBodies.length).toBeGreaterThan(0);
  const applyBody = capturedApplyBodies[0] as Record<string, unknown>;
  const resolutions = applyBody['resolutions'] as Array<{ file: string; action: string }>;
  expect(resolutions.length).toBe(2);
  expect(resolutions.every((r) => r.action === 'local')).toBe(true);
});

test('[AC-Sf17a4c-5-2] per-file モードで異なる選択を各ファイルに設定できる', async ({ page }) => {
  const capturedApplyBodies: unknown[] = [];

  await boot(page);

  await page.route('**/api/sync/link/preview', (route) => {
    void route.fulfill(json(previewWithConflicts()));
  });
  await page.route('**/api/sync/link/apply', (route) => {
    const body: unknown = route.request().postDataJSON();
    capturedApplyBodies.push(body);
    void route.fulfill(json(applySuccess(4, 3, 2)));
  });

  await openWizard(page);
  await page.getByTestId('sync-setup-remote-url').fill('https://github.com/test/vault.git');
  await page.getByTestId('sync-setup-wizard').getByTestId('sync-setup-start').click();

  await expect(page.getByTestId('link-conflict-dialog')).toBeVisible({ timeout: 8000 });

  // per-file モード (デフォルト): ファイル行が2つある
  const rows = page.getByTestId('link-conflict-row');
  expect(await rows.count()).toBe(2);

  // 1行目 = ローカル採用
  const row0 = rows.nth(0);
  await row0.locator('[data-testid="link-conflict-switch"][data-action="local"]').click();

  // 2行目 = リモート採用
  const row1 = rows.nth(1);
  await row1.locator('[data-testid="link-conflict-switch"][data-action="remote"]').click();

  await page.getByTestId('link-conflict-confirm').click();

  await expect(page.getByTestId('link-done-dialog')).toBeVisible({ timeout: 8000 });
  expect(capturedApplyBodies.length).toBeGreaterThan(0);
  const applyBody = capturedApplyBodies[0] as Record<string, unknown>;
  const resolutions = applyBody['resolutions'] as Array<{ file: string; action: string }>;
  expect(resolutions.length).toBe(2);
  // ファイルごとに異なる action
  const actions = resolutions.map((r) => r.action).sort();
  expect(actions).toEqual(['local', 'remote']);
});

// ============================================================
// [AC-Sf17a4c-5-2] mobile: ≤680px でのレイアウト確認
// ============================================================

test('[AC-Sf17a4c-5-2] mobile: 375px でダイアログとスイッチが利用可能', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });

  await boot(page);

  await page.route('**/api/sync/link/preview', (route) => {
    void route.fulfill(json(previewWithConflicts()));
  });
  await page.route('**/api/sync/link/apply', (route) => {
    void route.fulfill(json(applySuccess(4, 3, 2)));
  });

  // モバイルでは /settings/sync を直接開く
  await page.goto(`${readHarnessState().uiUrl}/settings/sync`);
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('sync-open-wizard').click();

  // ウィザードが可視
  await expect(page.getByTestId('sync-setup-wizard')).toBeVisible();
  await page.getByTestId('sync-setup-remote-url').fill('https://github.com/test/vault.git');
  await page.getByTestId('sync-setup-wizard').getByTestId('sync-setup-start').click();

  // 競合ダイアログが可視
  await expect(page.getByTestId('link-conflict-dialog')).toBeVisible({ timeout: 8000 });

  // スイッチが可視かつ高さ ≥ 40px (モバイル 44px 要件の許容差)
  const switches = page.getByTestId('link-conflict-switch');
  const count = await switches.count();
  expect(count).toBeGreaterThan(0);

  // 最初のスイッチのバウンディングボックスをチェック
  const firstSwitch = switches.first();
  await expect(firstSwitch).toBeVisible();
  const bbox = await firstSwitch.boundingBox();
  expect(bbox).not.toBeNull();
  if (bbox !== null) {
    expect(bbox.height).toBeGreaterThanOrEqual(40);
  }
});
