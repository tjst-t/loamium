/**
 * ツリー全展開/全折りたたみボタン mock テスト。
 *
 * ノート (物理) ビュー: tree-expand-all / tree-collapse-all で全フォルダの
 *   展開/折りたたみを切り替える (collapsedFolders)。
 * スマートビュー: 同じボタンで全スマートフォルダの expanded 状態を切り替える (treeSignal)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-22';
const JOURNAL_PATH = `journals/${TODAY}.md`;

/** 物理ツリー用: ネストしたフォルダ (projects/hydra) を含むノート一覧。 */
const NOTES = [
  { path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals' },
  { path: 'projects/hydra/design.md', title: 'design', tags: [], folder: 'projects/hydra' },
  { path: 'top.md', title: 'top', tags: [], folder: '' },
];

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
  return unexpected;
}

test('[MOCK] ノートツリー: 全折りたたみ→全展開でフォルダ内ノートの表示が切り替わる', async ({ page }) => {
  const unexpected = await boot(page);
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('file-tree')).toBeVisible();

  const nestedNote = page.locator('[data-testid="tree-item"][data-path="projects/hydra/design.md"]');
  const projectsFolder = page.locator('[data-testid="tree-folder"][data-path="projects"]');

  // ボタンが両方存在する
  await expect(page.getByTestId('tree-expand-all')).toBeVisible();
  await expect(page.getByTestId('tree-collapse-all')).toBeVisible();

  // 既定 (全展開): ネストしたノートが見える
  await expect(nestedNote).toBeVisible();

  // 全折りたたみ: トップフォルダは残るが、その中のノートは隠れる
  await page.getByTestId('tree-collapse-all').click();
  await expect(nestedNote).not.toBeVisible();
  await expect(projectsFolder).toBeVisible();
  await expect(projectsFolder).toHaveAttribute('aria-expanded', 'false');

  // 全展開: 再びネストしたノートが見える
  await page.getByTestId('tree-expand-all').click();
  await expect(nestedNote).toBeVisible();
  await expect(projectsFolder).toHaveAttribute('aria-expanded', 'true');

  expect(unexpected).toEqual([]);
});

test('[MOCK] スマートビュー: 全展開/全折りたたみで全スマートフォルダの展開が切り替わる', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [{ kind: 'query', id: 'q1', name: 'Q', icon: 'search', dql: 'LIST' }] })),
  );
  await page.route('**/api/smart-folders/*/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: 'a/x.md', title: 'X', folder: 'a', tags: [] }] })),
  );
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  const folder = page.locator('[data-testid="smart-folder"][data-id="q1"]');
  await expect(folder).toBeVisible();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');

  // 全展開: フォルダが展開され、解決結果のノートが表示される
  await page.getByTestId('tree-expand-all').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-testid="smart-note"][data-path="a/x.md"]')).toBeVisible();

  // 全折りたたみ: フォルダが閉じる
  await page.getByTestId('tree-collapse-all').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');

  expect(unexpected).toEqual([]);
});
