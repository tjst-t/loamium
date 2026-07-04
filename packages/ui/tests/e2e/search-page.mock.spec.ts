/**
 * Story S935867-1 mock テスト (詳細検索ページのエッジ・エラー・履歴)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証は
 * search-page.e2e.spec.ts (実サーバー) が行う。
 *
 * 検証観点:
 *  - 0 件 → search-empty
 *  - /api/notes / /api/search 失敗 → search-error に留まりアプリ全体には漏れない
 *  - タグ/フォルダ絞り込みはクライアント側 (q 空なら /api/search は呼ばない — decisions I2)
 *  - 検索履歴 (localStorage) の表示とクリック再実行
 *  - 結果を開いても一覧は保持され、複数の結果を順に閲覧できる (AC-1-1 の mock 版)
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

interface NoteMock {
  path: string;
  title: string;
  tags: string[];
  folder: string;
  mtime: number;
}

const NOTES: NoteMock[] = [
  { path: 'projects/Hydra 設計メモ.md', title: 'Hydra 設計メモ', tags: ['infra'], folder: 'projects', mtime: 5000 },
  { path: 'projects/自宅サーバー構成.md', title: '自宅サーバー構成', tags: ['infra'], folder: 'projects', mtime: 4000 },
  { path: 'reading/失敗の科学.md', title: '失敗の科学', tags: ['reading'], folder: 'reading', mtime: 3000 },
];

function searchResult(path: string, title: string, snippet: string, line: number | null): Record<string, unknown> {
  return { path, title, score: 0.01, snippet, line };
}

interface Mocks {
  unexpected: string[];
  searchCalls: string[];
}

/**
 * /search ルートへ直接遷移してモック環境で開く。
 * uiUrl は Vite dev。SPA フォールバックが /search に index.html を返す。
 */
async function openSearch(
  page: Page,
  query: string,
  opts: { searchResults?: unknown[]; failSearch?: boolean; failNotes?: boolean } = {},
): Promise<Mocks> {
  const unexpected = await installCatchAll(page);
  const searchCalls: string[] = [];
  await page.route('**/api/notes', (route) => {
    if (opts.failNotes === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
      return;
    }
    void route.fulfill(json({ notes: NOTES }));
  });
  await page.route('**/api/notes/**', (route) => {
    // getNote (プレビュー用): パスから title を snippet 化した簡易本文を返す
    const url = decodeURIComponent(new URL(route.request().url()).pathname);
    const rel = url.replace(/^\/api\/notes\//, '');
    void route.fulfill(
      json({ path: rel, content: `# ${rel}\n\n本文 ${rel} の中身。\n`, frontmatter: null, body: '', mtime: 1000 }),
    );
  });
  await page.route('**/api/search*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    searchCalls.push(q);
    if (opts.failSearch === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
      return;
    }
    void route.fulfill(json({ query: q, results: opts.searchResults ?? [] }));
  });
  await page.goto(`${readHarnessState().uiUrl}/search${query}`);
  await expect(page.getByTestId('search-page')).toBeVisible();
  return { unexpected, searchCalls };
}

test('[MOCK] 0 件ヒットは search-empty を表示し、結果行は出ない', async ({ page }) => {
  const { unexpected, searchCalls } = await openSearch(page, '?q=該当なし', { searchResults: [] });

  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(page.getByTestId('search-result-item')).toHaveCount(0);
  await expect(page.getByTestId('search-error')).toHaveCount(0);
  expect(searchCalls).toEqual(['該当なし']);
  expect(unexpected).toEqual([]);
});

test('[MOCK] /api/search 失敗は search-error に留まり、app-error には漏れない', async ({ page }) => {
  const { unexpected } = await openSearch(page, '?q=バックアップ', { failSearch: true });

  await expect(page.getByTestId('search-error')).toBeVisible();
  await expect(page.getByTestId('search-error')).toContainText('検索に失敗しました');
  await expect(page.getByTestId('search-result-item')).toHaveCount(0);
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] タグ/フォルダ絞り込みはクライアント側 — q 空なら /api/search を呼ばない', async ({ page }) => {
  const { unexpected, searchCalls } = await openSearch(page, '?tag=infra');

  // infra タグの 2 件だけが結果に出る (reading は除外)
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="search-result-item"][data-path="projects/Hydra 設計メモ.md"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="search-result-item"][data-path="reading/失敗の科学.md"]'),
  ).toHaveCount(0);
  // 全文キーワードが無いので /api/search は 1 度も呼ばれない
  expect(searchCalls).toEqual([]);
  expect(unexpected).toEqual([]);
});

test('[MOCK] /api/notes 失敗は search-error を表示する', async ({ page }) => {
  const { unexpected } = await openSearch(page, '?q=バックアップ', { failNotes: true });
  await expect(page.getByTestId('search-error')).toBeVisible();
  await expect(page.getByTestId('search-result-item')).toHaveCount(0);
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] AC-1-1: 結果を開いても一覧は保持され、複数の結果を順に閲覧できる', async ({ page }) => {
  const { unexpected } = await openSearch(page, '?q=サーバー', {
    searchResults: [
      searchResult('projects/Hydra 設計メモ.md', 'Hydra 設計メモ', 'サーバーのバックアップ方針', 3),
      searchResult('projects/自宅サーバー構成.md', '自宅サーバー構成', 'サーバー構成の全体像', 5),
    ],
  });

  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  // 1 件目を開く → プレビューが出るが一覧は残る
  await page.locator('[data-testid="search-result-item"][data-path="projects/Hydra 設計メモ.md"]').click();
  await expect(page.getByTestId('search-preview-pane')).toBeVisible();
  await expect(page.getByTestId('search-preview-pane')).toContainText('Hydra 設計メモ');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  // 2 件目を開く → プレビューが切り替わっても一覧はそのまま (閉じない)
  await page.locator('[data-testid="search-result-item"][data-path="projects/自宅サーバー構成.md"]').click();
  await expect(page.getByTestId('search-preview-pane')).toContainText('自宅サーバー構成');
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="search-result-item"][data-path="projects/自宅サーバー構成.md"].active'),
  ).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[MOCK] AC-1-3: 検索履歴が localStorage に記録され、クリックで再実行される', async ({ page }) => {
  const { unexpected, searchCalls } = await openSearch(page, '?q=バックアップ', {
    searchResults: [searchResult('projects/Hydra 設計メモ.md', 'Hydra 設計メモ', 'バックアップ方針', 3)],
  });
  await expect(page.getByTestId('search-result-item')).toHaveCount(1);

  // 条件をクリアして再検索 (別条件) — 履歴に「バックアップ」が積まれる
  await page.getByTestId('search-field-fulltext').fill('');
  await page.getByTestId('search-field-tag').fill('infra');
  await page.getByTestId('search-submit').click();
  await expect(page).toHaveURL(/\/search\?tag=infra$/);
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  // 履歴を見るため条件を空にして submit → search-history に 2 件
  await page.getByTestId('search-field-tag').fill('');
  await page.getByTestId('search-submit').click();
  await expect(page.getByTestId('search-history')).toBeVisible();
  const backup = page.locator('[data-testid="search-history-item"][data-query="q=%E3%83%90%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%97"]');
  await expect(backup).toBeVisible();

  // 履歴クリックで同じ検索が再実行される (URL 復元 + 結果再取得)
  await backup.click();
  await expect(page).toHaveURL(/q=%E3%83%90%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%97/);
  await expect(page.getByTestId('search-field-fulltext')).toHaveValue('バックアップ');
  await expect(page.getByTestId('search-result-item')).toHaveCount(1);

  expect(searchCalls).toContain('バックアップ');
  expect(unexpected).toEqual([]);
});
