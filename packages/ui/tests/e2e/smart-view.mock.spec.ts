/**
 * Story S8086d9-1 mock テスト (スマートビューのエラー/エッジ/状態)。
 * page.route で全 /api/* をモックする (gui-spec-S8086d9-1.json 参照)。
 * 受け入れ条件の本検証は smart-view.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-07';
const JOURNAL_PATH = `journals/${TODAY}.md`;

async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  // 起動時: 物理ツリー用のノート一覧 + 本日ジャーナルの遅延生成取得
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals' }] }));
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\nアンカー\n`;
    void route.fulfill(json({ date: TODAY, path: JOURNAL_PATH, content: body, frontmatter: null, body, created: false, mtime: 1000 }));
  });
  return unexpected;
}

test('[MOCK] スマートビュー: 定義が空なら空状態を表示', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => void route.fulfill(json({ version: 1, items: [] })));
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.getByTestId('smart-view-empty')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] スマートビュー: 定義取得失敗(500)でエラー状態を表示し、物理へ戻れる', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => void route.fulfill(json({ error: 'internal', message: 'boom' }, 500)));
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.getByTestId('smart-view-error')).toBeVisible();
  // アプリは壊れず物理ビューへ戻せる
  await page.getByTestId('sidebar-view-physical').click();
  await expect(page.getByTestId('file-tree')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] スマートフォルダ: query 解決失敗はフォルダ内エラーに留まる', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [{ kind: 'query', id: 'q1', name: 'Q', icon: 'search', dql: 'LIST' }] })),
  );
  await page.route('**/api/smart-folders/*/notes', (route) => void route.fulfill(json({ error: 'internal' }, 500)));
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  const folder = page.locator('[data-testid="smart-folder"][data-id="q1"]');
  await folder.click();
  await expect(folder.getByTestId('smart-folder-error')).toBeVisible();
  // ビュー全体は生きている (他フォルダやトグルは操作可能)
  await expect(page.getByTestId('smart-view')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] スマートフォルダ: query 解決結果が一覧表示される', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [{ kind: 'query', id: 'q1', name: 'Q', icon: 'clock', dql: 'LIST' }] })),
  );
  await page.route('**/api/smart-folders/*/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: 'a/x.md', title: 'X', folder: 'a', tags: [] }] })),
  );
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  const folder = page.locator('[data-testid="smart-folder"][data-id="q1"]');
  await folder.click();
  await expect(page.locator('[data-testid="smart-note"][data-path="a/x.md"]')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] スマートフォルダ: 未知アイコン名は絵文字としてそのまま描画される', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [{ kind: 'pin', id: 'p1', name: 'ピン', icon: '⭐', path: 'a/x.md' }] })),
  );
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  const icon = page.locator('[data-testid="smart-pin"][data-id="p1"] [data-testid="smart-folder-icon"]');
  await expect(icon).toHaveAttribute('data-icon', '⭐');
  expect(unexpected).toEqual([]);
});
