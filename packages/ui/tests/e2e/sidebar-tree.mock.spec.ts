/**
 * Story S79c210-1 mock テスト — サイドバー フォルダツリーのエッジ/エラーケース。
 * page.route で /api/* をモックする。受け入れ本検証は sidebar-tree.e2e.spec.ts が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

interface NoteMetaLike {
  path: string;
  title: string;
  tags: string[];
  folder: string;
  mtime?: number;
}

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

async function openApp(
  page: Page,
  opts: { notes?: NoteMetaLike[]; notesStatus?: number; files?: { path: string; size: number; mtime: number }[] },
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    if (opts.notesStatus !== undefined && opts.notesStatus >= 400) {
      void route.fulfill(json({ error: 'internal', message: 'boom' }, opts.notesStatus));
    } else {
      void route.fulfill(json({ notes: opts.notes ?? [] }));
    }
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('ジャーナル本文。\n')));
  });
  if (opts.files !== undefined) {
    await page.route('**/api/files', (route) => {
      void route.fulfill(json({ files: opts.files }));
    });
  }
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  return unexpected;
}

test('[MOCK] ノートはフォルダツリーで表示され、asset (非ノート) はツリーに出ない', async ({
  page,
}) => {
  await openApp(page, {
    notes: [
      { path: 'projects/hydra.md', title: 'hydra', tags: [], folder: 'projects', mtime: 3 },
      { path: 'projects/sub/deep.md', title: 'deep', tags: [], folder: 'projects/sub', mtime: 2 },
      { path: 'root-note.md', title: 'root-note', tags: [], folder: '', mtime: 1 },
    ],
    files: [{ path: 'assets/pic.png', size: 10, mtime: 5 }],
  });

  // フォルダ階層が出る
  await expect(page.locator('[data-testid="tree-folder"][data-path="projects"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-folder"][data-path="projects/sub"]')).toBeVisible();
  // フォルダ横断でノートに辿れる
  await expect(page.locator('[data-testid="tree-item"][data-path="projects/hydra.md"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="tree-item"][data-path="projects/sub/deep.md"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="tree-item"][data-path="root-note.md"]')).toBeVisible();
  // asset はツリーに一切出ない (assets フォルダも、pic.png も)
  await expect(page.locator('[data-testid="file-tree"] [data-path="assets/pic.png"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="tree-folder"][data-path="assets"]')).toHaveCount(0);
});

test('[MOCK] /api/notes 取得失敗はツリー内エラーで示す', async ({ page }) => {
  await openApp(page, { notesStatus: 500 });
  await expect(page.getByTestId('tree-error')).toBeVisible();
});

test('[MOCK] ルートの新規フォルダ作成でツリーに空フォルダが現れ、その中に新規ノート/フォルダの導線が出る', async ({
  page,
}) => {
  await openApp(page, {
    notes: [{ path: 'existing.md', title: 'existing', tags: [], folder: '', mtime: 1 }],
  });

  // サイドバーの新規フォルダボタン → ダイアログ → 作成
  await page.getByTestId('sidebar-new-folder').click();
  await page.getByTestId('new-folder-input').fill('uifolder');
  await page.getByTestId('new-folder-confirm').click();

  // 空フォルダが UI 状態としてツリーに現れる (ファイルには書かれない)
  const created = page.locator('[data-testid="tree-folder"][data-path="uifolder"]');
  await expect(created).toBeVisible();

  // そのフォルダを右クリック → ネスト作成の導線 (新規フォルダ / 新規ノート) が出る
  await created.click({ button: 'right' });
  await expect(page.getByTestId('tree-context-menu')).toBeVisible();
  await expect(page.getByTestId('context-new-folder')).toBeVisible();
  await expect(page.getByTestId('context-new-note')).toBeVisible();
});
