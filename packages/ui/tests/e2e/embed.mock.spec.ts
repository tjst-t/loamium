/**
 * Story S9e5ca4-1/2 mock テスト (embed のエラー・エッジケース)。
 * page.route で全 /api/* をモックする (gui-spec-S9e5ca4-1/2.json 参照)。
 * 受け入れ条件の本検証は embed.e2e.spec.ts (実サーバー) が行う。
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

function note(path: string, body: string): Record<string, unknown> {
  return { path, content: body, frontmatter: null, body, mtime: 1000 };
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

interface MockNotes {
  /** GET /api/notes の一覧に載せるパス */
  list: string[];
  /** GET /api/notes/{path} の応答 (パス → 本文)。未登録パスは 404 */
  bodies?: Record<string, string>;
  /** 本文取得を全件 500 にする */
  failNoteGet?: boolean;
  /** GET /api/files/** を全件 404 にする (catch-all より後に登録して有効化する) */
  files404?: boolean;
}

async function openWithJournal(
  page: Page,
  content: string,
  waitText: string,
  mock: MockNotes,
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  if (mock.files404 === true) {
    await page.route('**/api/files/**', (route) => {
      void route.fulfill(json({ error: 'not_found', message: 'file not found' }, 404));
    });
  }
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: mock.list.map((p) => ({
          path: p,
          title: (p.split('/').at(-1) ?? p).replace(/\.md$/, ''),
          tags: [],
          folder: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
        })),
      }),
    );
  });
  await page.route('**/api/notes/**', (route) => {
    if (mock.failNoteGet === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'mocked failure' }, 500));
      return;
    }
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname.replace(/^\/api\/notes\//, ''));
    const body = mock.bodies?.[rel];
    if (body === undefined) {
      void route.fulfill(json({ error: 'not_found', message: `note not found: ${rel}` }, 404));
      return;
    }
    void route.fulfill(json(note(rel, body)));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  await editorLine(page, waitText).click();
  return unexpected;
}

test('[MOCK] 解決できない ![[embed]] は壊れリンク同様のエラーカードになり、本文取得は飛ばない', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    '![[存在しないノート]]\n\nアンカー行。\n',
    'アンカー行',
    { list: [JOURNAL_PATH] },
  );

  const error = page.locator('[data-testid="embed-error"][data-target="存在しないノート.md"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText('ノートが見つかりません');
  await expect(page.getByTestId('embed-card')).toHaveCount(0);
  // 解決前に諦めるので GET /api/notes/{path} は呼ばれない (unexpected が空)
  expect(unexpected).toEqual([]);
});

test('[MOCK] 埋め込み先の取得が 500 でもカード内エラー表示に留まり、エディタは操作可能なまま', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    '![[サーバーエラー]]\n\nアンカー行。\n',
    'アンカー行',
    { list: [JOURNAL_PATH, 'サーバーエラー.md'], failNoteGet: true },
  );

  const card = page.locator('[data-testid="embed-card"][data-target="サーバーエラー.md"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('埋め込み先を読み込めませんでした');
  // エディタはクラッシュしていない
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(unexpected).toEqual([]);
});

test('[MOCK] ![[note#存在しない見出し]] はカード内の見出しエラーになる', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    '![[方針#存在しない見出し]]\n\nアンカー行。\n',
    'アンカー行',
    { list: [JOURNAL_PATH, '方針.md'], bodies: { '方針.md': '# 方針\n\n## ある見出し\n本文。\n' } },
  );

  const card = page.locator('[data-testid="embed-card"][data-target="方針.md"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-section', '存在しない見出し');
  await expect(card).toContainText('見出しが見つかりません: # 存在しない見出し');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 存在しない画像 (404) は壊れ表示になり、アプリは壊れない', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    '![[assets/消えた画像.png]]\n\nアンカー行。\n',
    'アンカー行',
    { list: [JOURNAL_PATH], files404: true },
  );

  const img = page.locator('[data-testid="embed-image"][data-path="assets/消えた画像.png"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('data-error', 'true');
  await expect(img).toContainText('画像を読み込めませんでした');
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 未対応拡張子の ![[file.xyz]] はエラーカードで打ち切られる (レジストリ未登録)', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    '![[data/バックアップ.xyz]]\n\nアンカー行。\n',
    'アンカー行',
    { list: [JOURNAL_PATH] },
  );

  const error = page.locator('[data-testid="embed-error"][data-target="data/バックアップ.xyz"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText('未対応');
  expect(unexpected).toEqual([]);
});
