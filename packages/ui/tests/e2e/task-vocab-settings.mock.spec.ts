/**
 * Se3b7a2-8 mock テスト — タスク語彙設定画面。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DEFAULT_VOCAB = {
  statuses: [
    { key: 'todo', label: 'TODO', color: '#64748b' },
    { key: 'progress', label: '進行中', color: '#2563eb' },
    { key: 'blocked', label: 'ブロック', color: '#dc2626' },
    { key: 'done', label: '完了', color: '#16a34a', done: true },
  ],
  priorities: [
    { key: 'highest', label: '最高', color: '#dc2626' },
    { key: 'high', label: '高', color: '#ea580c' },
    { key: 'medium', label: '中', color: '#2563eb' },
    { key: 'low', label: '低', color: '#64748b' },
  ],
};

async function openSettings(page: Parameters<typeof installCatchAll>[0]) {
  const unexpected = await installCatchAll(page);
  await page.goto(readHarnessState().uiUrl);
  // 設定ボタンを開く
  await page.getByTestId('sidebar-settings').click();
  // タスク語彙タブをクリック
  await page.locator('[data-testid="settings-nav-item"][data-group="tasks"]').click();
  return unexpected;
}

test('[MOCK][Se3b7a2-8] 設定ナビに「タスク語彙」が存在する', async ({ page }) => {
  await installCatchAll(page);
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-settings').click();
  const tasksNav = page.locator('[data-testid="settings-nav-item"][data-group="tasks"]');
  await expect(tasksNav).toBeVisible();
});

test('[MOCK][Se3b7a2-8] タスク語彙タブで settings-tasks が表示される', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByTestId('settings-tasks')).toBeVisible({ timeout: 5000 });
});

test('[MOCK][Se3b7a2-8] GET /api/settings/tasks でステータス行が描画される', async ({ page }) => {
  await openSettings(page);
  // デフォルトモックは 4 statuses を返す
  const rows = page.getByTestId('task-status-row');
  await expect(rows).toHaveCount(4, { timeout: 5000 });
  await expect(rows.first()).toHaveAttribute('data-key', 'todo');
});

test('[MOCK][Se3b7a2-8] GET /api/settings/tasks で優先度行が描画される', async ({ page }) => {
  await openSettings(page);
  const rows = page.getByTestId('task-priority-row');
  await expect(rows).toHaveCount(4, { timeout: 5000 });
});

test('[MOCK][Se3b7a2-8] done トグル (task-status-done-toggle) が完了ステータス行に存在する', async ({ page }) => {
  await openSettings(page);
  const toggles = page.getByTestId('task-status-done-toggle');
  await expect(toggles).toHaveCount(4, { timeout: 5000 });
  // done ステータス (idx=3) の toggle は aria-checked=true
  const doneToggle = toggles.nth(3);
  await expect(doneToggle).toHaveAttribute('aria-checked', 'true');
});

test('[MOCK][Se3b7a2-8] task-status-add ボタンでステータス行が増える', async ({ page }) => {
  await openSettings(page);
  await page.getByTestId('task-status-add').click();
  const rows = page.getByTestId('task-status-row');
  await expect(rows).toHaveCount(5, { timeout: 3000 });
});

test('[MOCK][Se3b7a2-8] task-priority-add ボタンで優先度行が増える', async ({ page }) => {
  await openSettings(page);
  await page.getByTestId('task-priority-add').click();
  const rows = page.getByTestId('task-priority-row');
  await expect(rows).toHaveCount(5, { timeout: 3000 });
});

test('[MOCK][Se3b7a2-8] tasks-yaml-preview が表示されている', async ({ page }) => {
  await openSettings(page);
  const preview = page.getByTestId('tasks-yaml-preview');
  await expect(preview).toBeVisible({ timeout: 5000 });
  // YAML に tasks: が含まれる
  const text = await preview.innerText();
  expect(text).toContain('tasks:');
});

test('[MOCK][Se3b7a2-8] ラベル編集で YAML プレビューが更新される', async ({ page }) => {
  await openSettings(page);
  const rows = page.getByTestId('task-status-row');
  await rows.first().waitFor({ timeout: 5000 });
  // 最初のステータスのラベル input を変更する
  const labelInput = rows.first().locator('input[aria-label="ステータスラベル"]');
  await labelInput.click({ clickCount: 3 });
  await labelInput.fill('カスタムTODO');
  const preview = page.getByTestId('tasks-yaml-preview');
  await expect(preview).toContainText('カスタムTODO', { timeout: 3000 });
});

test('[MOCK][Se3b7a2-8] settings-save で PUT /api/settings/tasks が呼ばれる', async ({ page }) => {
  const putCalls: string[] = [];
  await installCatchAll(page);
  await page.route('**/api/settings/tasks', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ vocab: DEFAULT_VOCAB }));
    } else if (method === 'PUT') {
      putCalls.push(route.request().url());
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fallback();
    }
  });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="tasks"]').click();
  await page.getByTestId('task-status-row').first().waitFor({ timeout: 5000 });
  await page.locator('[data-testid="settings-save"][data-group="tasks"]').click();
  await expect.poll(() => putCalls.length, { timeout: 3000 }).toBeGreaterThan(0);
});
