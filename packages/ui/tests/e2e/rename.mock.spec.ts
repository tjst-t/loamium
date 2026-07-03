/**
 * Story S6fbf45-3 mock テスト (UI リネームのエッジ・エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-S6fbf45-3.json 参照)。
 * 受け入れ条件の本検証は rename.e2e.spec.ts (実サーバー) と
 * tests/acceptance/rename.spec.ts (API 直叩き) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;
const TARGET = 'メモ.md';

function journal(content: string): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime: 1000 };
}

async function openApp(page: Page, opts: { failBacklinks?: boolean } = {}): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
          { path: TARGET, title: 'メモ', tags: [], folder: '' },
        ],
      }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  if (opts.failBacklinks === true) {
    await page.route('**/api/backlinks*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') === TARGET) {
        void route.fulfill(json({ error: 'internal_error', message: 'index down' }, 500));
        return;
      }
      void route.fulfill(json({ path: url.searchParams.get('path') ?? '', backlinks: [] }));
    });
  } else {
    await page.route('**/api/backlinks*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') === TARGET) {
        void route.fulfill(
          json({
            path: TARGET,
            backlinks: [
              { source: 'a.md', links: [{ raw: '[[メモ]]', heading: null, line: 1, context: 'x [[メモ]] y' }, { raw: '[[メモ#h]]', heading: 'h', line: 4, context: 'z [[メモ#h]]' }] },
              { source: 'b.md', links: [{ raw: '[[メモ|別名]]', heading: null, line: 2, context: '[[メモ|別名]] を参照' }] },
            ],
          }),
        );
        return;
      }
      void route.fulfill(json({ path: url.searchParams.get('path') ?? '', backlinks: [] }));
    });
  }
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  return unexpected;
}

async function openRenameDialog(page: Page): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${TARGET}"]`).click({ button: 'right' });
  await page.getByTestId('context-rename').click();
  await expect(page.getByTestId('rename-dialog')).toBeVisible();
}

test('[MOCK] リネームダイアログに「N ノートにある [[リンク]] M 件を自動更新」が表示される', async ({ page }) => {
  const unexpected = await openApp(page);
  await openRenameDialog(page);

  const note = page.getByTestId('rename-link-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('2 ノートにある');
  await expect(note).toContainText('[[リンク]] 3 件');
  await expect(note).toContainText('コードフェンス内は変更されません');
  expect(unexpected).toEqual([]);
});

test('[MOCK] リンク件数の取得に失敗してもダイアログは使え、リネームは実行できる', async ({ page }) => {
  const unexpected = await openApp(page, { failBacklinks: true });
  const renamed: string[] = [];
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().includes('/rename')) {
      renamed.push(JSON.stringify(req.postDataJSON()));
      void route.fulfill(
        json({ oldPath: TARGET, path: 'メモ2.md', mtime: 3000, updatedNotes: [], updatedLinks: 0 }),
      );
      return;
    }
    void route.fallback();
  });

  await openRenameDialog(page);
  const note = page.getByTestId('rename-link-note');
  await expect(note).toContainText('リンク数を確認できませんでした');

  await page.getByTestId('rename-input').fill('メモ2');
  await page.getByTestId('rename-confirm').click();
  await expect(page.getByTestId('rename-dialog')).not.toBeVisible();
  await expect.poll(() => renamed).toEqual(['{"newPath":"メモ2.md"}']);
  expect(unexpected).toEqual([]);
});

test('[MOCK] リネーム先が既存 (409) なら app-error を表示し、ツリーは変わらない', async ({ page }) => {
  const unexpected = await openApp(page);
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().includes('/rename')) {
      void route.fulfill(json({ error: 'conflict', message: 'rename target already exists' }, 409));
      return;
    }
    void route.fallback();
  });

  await openRenameDialog(page);
  await page.getByTestId('rename-input').fill('既存ノート');
  await page.getByTestId('rename-confirm').click();

  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.getByTestId('app-error')).toContainText('既に存在します');
  await expect(page.locator(`[data-testid="tree-item"][data-path="${TARGET}"]`)).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] リネーム成功で POST /rename が呼ばれ、GET+PUT+DELETE の合成は使われない', async ({ page }) => {
  const unexpected = await openApp(page);
  const calls: string[] = [];
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${decodeURIComponent(url.pathname)}`);
    if (req.method() === 'POST' && req.url().includes('/rename')) {
      void route.fulfill(
        json({
          oldPath: TARGET,
          path: 'メモ改.md',
          mtime: 3000,
          updatedNotes: [{ path: 'a.md', links: 2 }],
          updatedLinks: 2,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await openRenameDialog(page);
  await page.getByTestId('rename-input').fill('メモ改');
  await page.getByTestId('rename-confirm').click();
  await expect(page.getByTestId('rename-dialog')).not.toBeVisible();

  await expect.poll(() => calls).toContain('POST /api/notes/メモ.md/rename');
  expect(calls.filter((c) => c.startsWith('PUT') || c.startsWith('DELETE'))).toEqual([]);
  expect(unexpected).toEqual([]);
});
