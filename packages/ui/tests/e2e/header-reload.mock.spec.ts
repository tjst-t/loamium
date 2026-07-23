/**
 * ヘッダのリロードボタン mock テスト。
 *
 * `<` `>` とパンくずの間のリロードボタンで、現在の画面 (ノート/ファイル一覧/設定) を
 * サーバーから再取得する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-22';
const JOURNAL_PATH = `journals/${TODAY}.md`;

async function bootWithNote(page: Page): Promise<{ unexpected: string[]; noteGets: () => number }> {
  const unexpected = await installCatchAll(page);
  let noteGets = 0;
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'メモ.md', title: 'メモ', tags: [], folder: '' }] }));
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json({ date: TODAY, path: JOURNAL_PATH, content: '# journal\n', frontmatter: null, body: '# journal\n', created: false, mtime: 1000 }));
  });
  // GET /api/notes/{path}: 1 回目は v1、以降は v2 (リロードで最新化されることを検証)
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      noteGets += 1;
      const content = noteGets === 1 ? '本文バージョン1\n' : '本文バージョン2\n';
      void route.fulfill(json({ path: 'メモ.md', content, frontmatter: null, body: content, mtime: noteGets * 100 }));
      return;
    }
    void route.fallback();
  });
  // meta は info パネルの定常呼び出し (last-win で noteGets に影響させない)
  await page.route('**/api/notes/**/meta', (route) => {
    void route.fulfill(json({ path: 'メモ.md', headings: [], outgoingLinks: [], tags: [], frontmatter: null, mtime: 100, wordCount: 0, charCount: 0 }));
  });
  await page.goto(readHarnessState().uiUrl);
  return { unexpected, noteGets: () => noteGets };
}

test('[MOCK] リロードボタンがノート/ファイル一覧/設定の各画面に表示される', async ({ page }) => {
  await bootWithNote(page);
  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toBeVisible();

  // ノート画面
  await expect(page.getByTestId('header-reload')).toBeVisible();
  // ファイル一覧
  await page.getByTestId('sidebar-show-all').click();
  await expect(page.getByTestId('files-filter')).toBeVisible();
  await expect(page.getByTestId('header-reload')).toBeVisible();
  // 設定
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await expect(page.getByTestId('header-reload')).toBeVisible();
});

test('[MOCK] ノートでリロードすると本文がサーバーから再取得され最新化される', async ({ page }) => {
  const { noteGets } = await bootWithNote(page);
  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toContainText('本文バージョン1');
  expect(noteGets()).toBe(1);

  // リロード → 同一ノートでも再取得され、最新内容に置き換わる
  await page.getByTestId('header-reload').click();
  await expect(page.getByTestId('editor')).toContainText('本文バージョン2');
  expect(noteGets()).toBe(2);
});

test('[MOCK] 設定でリロードすると設定がサーバーから再取得される', async ({ page }) => {
  await bootWithNote(page);
  let systemGets = 0;
  // installCatchAll の /api/settings/system を後勝ちで上書きし、GET 回数を数える
  await page.route('**/api/settings/system', (route) => {
    if (route.request().method() === 'GET') {
      systemGets += 1;
      void route.fulfill(json({ settings: { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false } }));
      return;
    }
    void route.fallback();
  });

  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  const before = systemGets;

  await page.getByTestId('header-reload').click();
  // 再マウント + refreshAppSettings で /api/settings/system が再取得される
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await expect.poll(() => systemGets).toBeGreaterThan(before);
});
