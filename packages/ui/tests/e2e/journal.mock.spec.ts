/**
 * Story Sa704c3-2 mock テスト (ジャーナル着地とナビゲーションのエッジケース)。
 * page.route で全 /api/* をモックする。モック形は packages/server/src/routes/journal.ts
 * の実レスポンス構造に一致させる (gui-spec-Sa704c3-2.json の endpoint_contracts 参照)。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

/** journals/YYYY/MM/YYYY-MM-DD.md — 実サーバーの journalPath に一致させる。 */
function jpath(date: string): string {
  return `journals/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
}

function journal(date: string, content: string, mtime = 1000): Record<string, unknown> {
  return {
    date,
    path: jpath(date),
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime,
  };
}


test('[MOCK] 起動時に GET /api/journal が呼ばれ、返った内容がエディタに開く', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  let journalCalls = 0;
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'journals/2026/07/2026-07-03.md', title: '2026-07-03', tags: [], folder: 'journals/2026/07' }] }));
  });
  await page.route('**/api/journal', (route) => {
    journalCalls += 1;
    void route.fulfill(json(journal('2026-07-03', '# きょうのジャーナル\n\n朝のメモ。\n')));
  });

  await page.goto(readHarnessState().uiUrl);

  await expect(page.getByTestId('editor')).toContainText('きょうのジャーナル');
  await expect(page.getByTestId('journal-today')).toContainText('2026-07-03');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const active = page.locator('[data-testid="tree-item"][data-path="journals/2026/07/2026-07-03.md"]');
  await expect(active).toHaveClass(/active/);
  expect(journalCalls).toBeGreaterThan(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] journal 取得失敗で empty state に落ち、empty-open-journal の再試行で開ける', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  let journalCalls = 0;
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    journalCalls += 1;
    if (journalCalls === 1) {
      void route.fulfill(json({ error: 'io_error', message: 'transient failure' }, 500));
    } else {
      void route.fulfill(json(journal('2026-07-03', '# 復帰\n')));
    }
  });

  await page.goto(readHarnessState().uiUrl);

  await expect(page.getByTestId('editor-empty-state')).toBeVisible();
  await page.getByTestId('empty-open-journal').click();
  await expect(page.getByTestId('editor')).toContainText('復帰');
  expect(journalCalls).toBe(2);
  expect(unexpected).toEqual([]);
});

test('[MOCK] journal-prev は前日 (月境界を跨ぐ) の date パラメータで取得する', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  const datesRequested: Array<string | null> = [];
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal*', (route) => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get('date');
    datesRequested.push(date);
    if (date === null) {
      void route.fulfill(json(journal('2026-07-01', '# 月初\n')));
    } else {
      void route.fulfill(json(journal(date, `# ${date} のジャーナル\n`)));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('月初');

  await page.getByTestId('journal-prev').click();
  await expect(page.getByTestId('editor')).toContainText('2026-06-30 のジャーナル');
  // 今日の表示は変わらない (今日 = サーバーが返した無指定日)
  await expect(page.getByTestId('journal-today')).toContainText('2026-07-01');

  // 前日のジャーナルを開いた状態からの journal-next は翌日 (=月初に戻る)
  await page.getByTestId('journal-next').click();
  await expect(page.getByTestId('editor')).toContainText('2026-07-01 のジャーナル');

  expect(datesRequested).toEqual([null, '2026-06-30', '2026-07-01']);
  expect(unexpected).toEqual([]);
});

test('[MOCK] ジャーナル一覧は journals/ の YYYY-MM-DD.md だけを新しい順に表示する', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'journals/2026/06/2026-06-30.md', title: '2026-06-30', tags: [], folder: 'journals/2026/06' },
          { path: 'journals/2026/07/2026-07-02.md', title: '2026-07-02', tags: [], folder: 'journals/2026/07' },
          { path: 'journals/2026/07/メモ.md', title: 'メモ', tags: [], folder: 'journals/2026/07' },
          { path: 'journals/2026/02/2026-02-30.md', title: '2026-02-30', tags: [], folder: 'journals/2026/02' },
          { path: 'other/2026-01-01.md', title: '2026-01-01', tags: [], folder: 'other' },
        ],
      }),
    );
  });
  await page.route('**/api/journal*', (route) => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get('date') ?? '2026-07-03';
    void route.fulfill(json(journal(date, `# ${date}\n`)));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('2026-07-03');

  await page.getByTestId('journal-open-list').click();
  await expect(page.getByTestId('journal-list')).toBeVisible();

  const items = page.getByTestId('journal-list-item');
  // journals/メモ.md・実在しない 2026-02-30・journals 外の日付ファイルは除外、降順
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('data-date', '2026-07-02');
  await expect(items.nth(1)).toHaveAttribute('data-date', '2026-06-30');

  await items.nth(1).click();
  await expect(page.getByTestId('editor')).toContainText('2026-06-30');
  await expect(page.getByTestId('journal-list')).not.toBeVisible();
  expect(unexpected).toEqual([]);
});
