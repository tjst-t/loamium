/**
 * system/ ネストフォルダツリー mock テスト (Sa10026-9 #4/#5)。
 *
 * Sa10026-4 の表示/非表示トグルは撤去 (#5)。system/ は常時表示のネストツリーで、
 * 上のノートツリーと同じフォルダ構造で描画する (#4)。ファイル一覧は
 * GET /api/system-files から取得し、クリックで GET /api/system-files/{path}/source 経由で
 * 編集エディタに開く。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-14';
const JOURNAL_PATH = `journals/${DATE}.md`;

const REGULAR_NOTES = [
  { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals', mtime: 1000 },
  { path: 'projects/hydra.md', title: 'Hydra', tags: [], folder: 'projects', mtime: 2000 },
];

const SYSTEM_FILES = [
  { path: 'system/settings.yaml', size: 40, mtime: 6000 },
  { path: 'system/smart-folders/journal.yaml', size: 30, mtime: 3000 },
  { path: 'system/smart-folders/recent.yaml', size: 30, mtime: 3001 },
  { path: 'system/templates/journal.md', size: 50, mtime: 4000 },
  { path: 'system/commands/create-todo.yaml', size: 20, mtime: 5000 },
];

function journalResponse(): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content: '# Journal\n',
    frontmatter: null,
    body: '# Journal\n',
    created: false,
    mtime: 1000,
  };
}

async function boot(page: Page, systemFiles = SYSTEM_FILES): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: REGULAR_NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/system-files', (route) => {
    void route.fulfill(json({ files: systemFiles }));
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  return unexpected;
}

// ===========================================================================
// [#5] トグルは撤去され、system/ ツリーは常時表示される
// ===========================================================================

test('[#5] tree-system-toggle は存在せず、system/ ツリーが常時表示される', async ({ page }) => {
  await boot(page);
  // 旧トグルは撤去
  await expect(page.getByTestId('tree-system-toggle')).toHaveCount(0);
  // system/ ツリーは常時表示
  await expect(page.getByTestId('tree-system')).toBeVisible();
  await expect(page.getByTestId('tree-system-root')).toBeVisible();
});

// ===========================================================================
// [#4] ネストしたフォルダ構造で描画される
// ===========================================================================

test('[#4] system/ 配下がネストしたフォルダツリーで描画される', async ({ page }) => {
  await boot(page);
  const tree = page.getByTestId('tree-system');
  // サブフォルダ (tree-folder) がネスト表示される
  await expect(tree.locator('[data-testid="tree-folder"][data-path="system/smart-folders"]')).toBeVisible();
  await expect(tree.locator('[data-testid="tree-folder"][data-path="system/templates"]')).toBeVisible();
  await expect(tree.locator('[data-testid="tree-folder"][data-path="system/commands"]')).toBeVisible();
  // system/ 直下の settings.yaml がファイルとして描画される
  await expect(tree.locator('[data-testid="tree-item"][data-path="system/settings.yaml"]')).toBeVisible();
  // サブフォルダ内のファイルも描画される
  await expect(
    tree.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]'),
  ).toBeVisible();
});

// ===========================================================================
// [#4] system/ ファイルは通常 file-tree に混入しない
// ===========================================================================

test('[#4] system/ ファイルは通常 file-tree に混入しない', async ({ page }) => {
  await boot(page);
  const fileTree = page.getByTestId('file-tree');
  await expect(fileTree.locator('[data-path^="system/"]')).toHaveCount(0);
  await expect(fileTree.locator('[data-path="system"]')).toHaveCount(0);
});

// ===========================================================================
// [#4] サブフォルダを折りたためる (通常フォルダと同じ操作感)
// ===========================================================================

test('[#4] system/ サブフォルダを折りたたむと中のファイルが隠れる', async ({ page }) => {
  await boot(page);
  const tree = page.getByTestId('tree-system');
  const journalFile = tree.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]');
  await expect(journalFile).toBeVisible();
  // smart-folders フォルダをクリックして折りたたむ
  await tree.locator('[data-testid="tree-folder"][data-path="system/smart-folders"]').click();
  await expect(journalFile).not.toBeVisible();
});

// ===========================================================================
// [#4] ファイルクリックで system-files source 経由で編集エディタが開く
// ===========================================================================

test('[#4] system/settings.yaml をクリックすると Editor で開く (yaml source 経由)', async ({ page }) => {
  const YAML = 'theme: system\ndefaultFolder: hoge\n';
  await page.route('**/api/system-files/system/settings.yaml/source', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ path: 'system/settings.yaml', content: YAML, mtime: 6000 }));
    } else {
      void route.fallback();
    }
  });

  await boot(page);
  const item = page
    .getByTestId('tree-system')
    .locator('[data-testid="tree-item"][data-path="system/settings.yaml"]');
  await item.click();

  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('save-status')).toBeVisible();
});

// ===========================================================================
// [#4] Edge: system/ ファイルが 0 件でもツリー (ルート) は表示される
// ===========================================================================

test('[#4] system/ ファイルが 0 件でもルートフォルダは表示される', async ({ page }) => {
  const unexpected = await boot(page, []);
  await expect(page.getByTestId('tree-system')).toBeVisible();
  await expect(page.getByTestId('tree-system-root')).toBeVisible();
  await expect(page.getByTestId('tree-system-empty')).toBeVisible();
  expect(unexpected).toEqual([]);
});
