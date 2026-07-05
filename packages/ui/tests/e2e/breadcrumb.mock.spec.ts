/**
 * Story S79c210-4 mock テスト — パンくずが /n/ を露出しないこと (ルート/フォルダ両方)。
 * 受け入れ本検証は breadcrumb.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

function noteResponse(path: string, content: string): Record<string, unknown> {
  return { path, content, frontmatter: null, body: content, mtime: 2000, created: false };
}

async function openApp(page: Page): Promise<void> {
  await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'ルート.md', title: 'ルート', tags: [], folder: '', mtime: 2 },
          { path: 'projects/子.md', title: '子', tags: [], folder: 'projects', mtime: 1 },
        ],
      }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('ジャーナル本文。\n')));
  });
  await page.route('**/api/notes/**', (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname.replace(/^\/api\/notes\//, ''));
    void route.fulfill(json(noteResponse(rel, `# ${rel}\n\n本文 ${rel}\n`)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
}

test('[AC-S79c210-4-1] ルート/フォルダ配下いずれのノートでもパンくずに /n/ を露出しない', async ({
  page,
}) => {
  await openApp(page);
  const crumb = page.getByTestId('route-display');

  // ルート直下のノート: 名前のみ、/n/ もフォルダ区切りも出ない
  await page.locator('[data-testid="tree-item"][data-path="ルート.md"]').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('ルート');
  await expect(crumb).not.toContainText('/n/');

  // フォルダ配下のノート: フォルダ名 + ノート名、/n/ は出ない
  await page.locator('[data-testid="tree-item"][data-path="projects/子.md"]').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('子');
  await expect(crumb).toContainText('projects');
  await expect(crumb).not.toContainText('/n/');
});
