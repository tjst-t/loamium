/**
 * Story Sbd061c-1 mock テスト (検索パレットのエッジ・エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-Sbd061c-1.json 参照)。
 * 受け入れ条件の本検証は search-palette.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

const NOTES = {
  notes: [
    { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
    { path: 'projects/監査ログ設計.md', title: '監査ログ設計', tags: [], folder: 'projects' },
    { path: 'reading/セキュリティ監査の教科書.md', title: 'セキュリティ監査の教科書', tags: [], folder: 'reading' },
    { path: '週次レビュー.md', title: '週次レビュー', tags: [], folder: '' },
  ],
};

function journal(content: string): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime: 1000 };
}

function searchResult(path: string, title: string, snippet: string, line: number | null): Record<string, unknown> {
  return { path, title, score: 0.01, snippet, line };
}

interface SearchMock {
  calls: string[];
}

async function openApp(
  page: Page,
  opts: { searchResults?: unknown[]; failSearch?: boolean } = {},
): Promise<{ unexpected: string[]; search: SearchMock }> {
  const unexpected = await installCatchAll(page);
  const search: SearchMock = { calls: [] };
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json(NOTES));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  await page.route('**/api/search*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    search.calls.push(q);
    if (opts.failSearch === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
      return;
    }
    void route.fulfill(json({ query: q, results: opts.searchResults ?? [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  return { unexpected, search };
}

test('[MOCK] デバウンス: 高速連続入力では GET /api/search は最後のクエリで 1 回だけ飛ぶ', async ({ page }) => {
  const { unexpected, search } = await openApp(page, {
    searchResults: [searchResult('週次レビュー.md', '週次レビュー', '監査ログの棚卸しを実施', 7)],
  });

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('search-input').pressSequentially('監査ログ');

  // ノート名一致 (ローカルフィルタ) は打鍵に追従してインクリメンタルに出る
  await expect(page.getByTestId('search-result-note')).toHaveCount(1);
  // 全文ヒットはデバウンス後に 1 回だけ取得される
  await expect(page.getByTestId('search-result-fulltext')).toHaveCount(1);
  expect(search.calls).toEqual(['監査ログ']);
  expect(unexpected).toEqual([]);
});

test('[MOCK] /api/search 失敗はパレット内 search-error に留まり、ノート名一致とエディタは生きたまま', async ({ page }) => {
  const { unexpected } = await openApp(page, { failSearch: true });

  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').pressSequentially('監査');

  await expect(page.getByTestId('search-error')).toBeVisible();
  await expect(page.getByTestId('search-error')).toContainText('全文検索に失敗しました');
  // ローカルのノート名フィルタは生きている (監査ログ設計 + セキュリティ監査の教科書)
  await expect(page.getByTestId('search-result-note')).toHaveCount(2);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);
  // アプリ全体には漏れない
  await expect(page.getByTestId('app-error')).toHaveCount(0);

  // Esc で閉じてエディタは編集可能なまま
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await page.locator('[data-testid="editor"] .cm-line', { hasText: '本文。' }).first().click();
  await page.keyboard.type('追記');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 一致 0 件では search-empty を表示し、セクション見出しは出ない', async ({ page }) => {
  const { unexpected, search } = await openApp(page, { searchResults: [] });

  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').pressSequentially('該当なしクエリ');

  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(page.getByTestId('search-empty')).toContainText('該当なしクエリ');
  await expect(page.getByTestId('palette-section-notes')).toHaveCount(0);
  await expect(page.getByTestId('palette-section-fulltext')).toHaveCount(0);
  await expect(page.getByTestId('search-result-note')).toHaveCount(0);
  expect(search.calls).toEqual(['該当なしクエリ']);
  expect(unexpected).toEqual([]);
});

test('[MOCK] IME 変換中は全文検索を確定せず、compositionend で 1 回だけ検索する', async ({ page }) => {
  const { unexpected, search } = await openApp(page, {
    searchResults: [searchResult('週次レビュー.md', '週次レビュー', '監査対応の週次確認', 3)],
  });

  await page.keyboard.press('Control+k');
  const input = page.getByTestId('search-input');
  await input.click();

  // IME 変換開始 → 変換中の打鍵では /api/search が飛ばない (ノート名フィルタは追従)
  await input.dispatchEvent('compositionstart');
  await input.pressSequentially('監査');
  await expect(page.getByTestId('search-result-note')).toHaveCount(2);
  await page.waitForTimeout(500); // デバウンス (200ms) を十分越えて確認
  expect(search.calls).toEqual([]);

  // 変換確定 (compositionend) で確定テキストの検索が 1 回だけ走る
  await input.dispatchEvent('compositionend');
  await expect(page.getByTestId('search-result-fulltext')).toHaveCount(1);
  expect(search.calls).toEqual(['監査']);
  expect(unexpected).toEqual([]);
});

test('[MOCK] line が null の全文ヒット (タイトルのみ一致) は全文セクションに出ない', async ({ page }) => {
  const { unexpected } = await openApp(page, {
    searchResults: [
      searchResult('projects/監査ログ設計.md', '監査ログ設計', '監査ログ設計', null),
      searchResult('週次レビュー.md', '週次レビュー', '- [x] 監査イベントの JSON スキーマをレビュー', 12),
    ],
  });

  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').pressSequentially('監査');

  await expect(page.getByTestId('search-result-fulltext')).toHaveCount(1);
  const hit = page.getByTestId('search-result-fulltext');
  await expect(hit).toHaveAttribute('data-path', '週次レビュー.md');
  await expect(hit).toHaveAttribute('data-line', '12');
  await expect(hit).toContainText('L12');
  // タイトルのみ一致はノート名セクション側に出ている (重複しない)
  await expect(
    page.locator('[data-testid="search-result-note"][data-path="projects/監査ログ設計.md"]'),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] パレット表示中の Cmd/Ctrl+K 再押下は閉じずに入力を全選択する', async ({ page }) => {
  const { unexpected } = await openApp(page, { searchResults: [] });

  await page.keyboard.press('Control+k');
  const input = page.getByTestId('search-input');
  await input.pressSequentially('監査');
  await expect(page.getByTestId('search-result-note')).toHaveCount(2);

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(input).toBeFocused();
  const selection = await input.evaluate((el) => {
    const i = el as HTMLInputElement;
    return { start: i.selectionStart, end: i.selectionEnd, value: i.value };
  });
  expect(selection).toEqual({ start: 0, end: 2, value: '監査' });
  // 全選択状態から打ち直すと置き換わる
  await input.pressSequentially('週次');
  await expect(
    page.locator('[data-testid="search-result-note"][data-path="週次レビュー.md"]'),
  ).toBeVisible();
  await expect(page.getByTestId('search-result-note')).toHaveCount(1);
  expect(unexpected).toEqual([]);
});
