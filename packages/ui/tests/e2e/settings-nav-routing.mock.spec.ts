/**
 * 設定ハブのヘッダ + URL ルーティング + 右サイドバー自動折りたたみ mock テスト。
 *
 * - 設定にも < > 付きヘッダ (editor-header) が出て、各グループが /settings/<group> に載る。
 * - 設定に入ると右サイドバーが自動で折りたたまれ、抜けると元の状態が復元される。
 * - コンテンツ群 (テンプレート〜タスク語彙) を開くとサブメニュー (settings-nav) が隠れ、
 *   戻る (ヘッダの <) でメニューへ戻れる。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-22';
const JOURNAL_PATH = `journals/${TODAY}.md`;
const NOTES = [{ path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals' }];

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
    const body = `# ${TODAY}\n\n本文\n`;
    void route.fulfill(json({ date: TODAY, path: JOURNAL_PATH, content: body, frontmatter: null, body, created: false, mtime: 1000 }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  return unexpected;
}

test('[MOCK] 設定ヘッダの < > と URL、右サイドバー自動折りたたみ・復元、コンテンツ群のサブメニュー非表示', async ({ page }) => {
  await boot(page);

  const rightSidebar = page.getByTestId('right-sidebar');
  const settingsNav = page.getByTestId('settings-nav');

  // 初期: 右サイドバーは展開
  await expect(rightSidebar).not.toHaveClass(/collapsed/);

  // 設定を開く → ヘッダに /settings、右サイドバー自動折りたたみ、URL /settings
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await expect(page.getByTestId('route-display')).toContainText('/settings');
  await expect(rightSidebar).toHaveClass(/collapsed/);
  await expect(page).toHaveURL(/\/settings$/);
  // メニュー/設定群ではサブメニューが見える
  await expect(settingsNav).toBeVisible();

  // エージェント群へ → URL /settings/agent、サブメニューは見えたまま (設定群)
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await expect(page).toHaveURL(/\/settings\/agent$/);
  await expect(settingsNav).toBeVisible();

  // テンプレート (コンテンツ群) を開く → URL /settings/templates、詳細が全幅、サブメニュー非表示
  await page.locator('[data-testid="settings-nav-item"][data-group="templates"]').click();
  await expect(page).toHaveURL(/\/settings\/templates$/);
  await expect(page.locator('[data-testid="md-panel"][data-group="templates"]')).toBeVisible();
  await expect(settingsNav).not.toBeVisible();

  // ヘッダの戻るで一つ戻る (エージェント群 → サブメニュー復帰)
  await page.getByTestId('nav-back').click();
  await expect(page).toHaveURL(/\/settings\/agent$/);
  await expect(settingsNav).toBeVisible();

  // 設定を抜けてノートへ戻る → 右サイドバーが元の展開状態に復元される
  await page.getByTestId('nav-back').click(); // /settings (メニュー)
  await page.getByTestId('nav-back').click(); // /n/... (ノート)
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(rightSidebar).not.toHaveClass(/collapsed/);
});

test('[MOCK] 設定中でも右サイドバーを手動で開閉でき、抜けると設定前の状態に戻る', async ({ page }) => {
  await boot(page);

  const rightSidebar = page.getByTestId('right-sidebar');
  const toggle = page.getByTestId('right-sidebar-toggle');

  // 設定前: 展開
  await expect(rightSidebar).not.toHaveClass(/collapsed/);

  // 設定を開く → 自動折りたたみ
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await expect(rightSidebar).toHaveClass(/collapsed/);

  // 設定中でもトグルで手動で開ける (Agent にテンプレ作成させる導線)
  await toggle.click();
  await expect(rightSidebar).not.toHaveClass(/collapsed/);
  // 開いたら Agent タブが既定で選択され、インフォタブは無効 (設定中はノート未オープン)
  await expect(page.getByTestId('right-tab-agent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('right-tab-info')).toBeDisabled();
  await expect(page.getByTestId('right-tab-info')).toHaveAttribute('aria-selected', 'false');

  // 設定中にまた手動で閉じる
  await toggle.click();
  await expect(rightSidebar).toHaveClass(/collapsed/);

  // 設定を抜ける → 設定前の状態 (展開) に復元 (設定中の手動折りたたみは破棄)
  await page.getByTestId('nav-back').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(rightSidebar).not.toHaveClass(/collapsed/);
});
