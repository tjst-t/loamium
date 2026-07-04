/**
 * Story Sb1593c-2 mock テスト (dataview フェンスのエッジ / エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-Sb1593c-2.json 参照)。
 * 受け入れ条件の本検証は dataview.e2e.spec.ts (実サーバー) が行う。
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

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

/**
 * ジャーナルを開くが、アンカー行はまだクリックしない。
 * 起動直後はカーソルが 1 行目 (```dataview) にあり fence はソース表示のままなので
 * /api/query は飛ばない。各テストが query の route を登録してからクリックする。
 */
async function openWithJournal(page: Page, content: string, waitText: string): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  return unexpected;
}

const FENCE_NOTE = ['```dataview', 'LIST from #project', '```', '', 'アンカー行。', ''].join('\n');

test('[MOCK] LIST 結果が dataview-widget[data-query-type=list] として描画される (空フォルダは path 無し)', async ({ page }) => {
  const unexpected = await openWithJournal(page, FENCE_NOTE, 'アンカー行');
  await page.route('**/api/query', (route) => {
    void route.fulfill(
      json({
        type: 'list',
        results: [
          { path: 'projects/Hydra.md', title: 'Hydra', folder: 'projects' },
          { path: 'ルート直下.md', title: 'ルート直下', folder: '' },
        ],
      }),
    );
  });
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'list');
  const items = page.getByTestId('dataview-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('data-path', 'projects/Hydra.md');
  await expect(items.nth(0)).toContainText('projects/');
  await expect(items.nth(1)).not.toContainText('/');
  expect(unexpected).toEqual([]);
});

test('[MOCK] TABLE の null セルは空欄、配列セルは #タグ チップになる', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['```dataview', 'TABLE status, tags from "projects"', '```', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await page.route('**/api/query', (route) => {
    void route.fulfill(
      json({
        type: 'table',
        fields: ['status', 'tags'],
        results: [
          { path: 'projects/a.md', title: 'a', folder: 'projects', values: ['done', ['project', 'infra']] },
          { path: 'projects/b.md', title: 'b', folder: 'projects', values: [null, null] },
        ],
      }),
    );
  });
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'table');
  await expect(widget.locator('thead th')).toHaveText(['ノート', 'status', 'tags']);
  await expect(widget.locator('.dv-tag')).toHaveText(['#project', '#infra']);
  await expect(widget.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('');
  expect(unexpected).toEqual([]);
});

test('[MOCK] TASK の 0 件は「0 件」の空表示になる', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['```dataview', 'TASK where !completed', '```', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await page.route('**/api/query', (route) => {
    void route.fulfill(json({ type: 'task', results: [] }));
  });
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'task');
  await expect(widget).toContainText('0 件');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 構文エラー (400) はキャレット + 位置情報付きで dataview-error に表示される', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['```dataview', 'LIST form #reading', '```', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await page.route('**/api/query', (route) => {
    void route.fulfill(
      json(
        {
          error: 'query_syntax',
          message: "1 行 6 列: 予期しないトークン 'form' — 'from' / 'where' / 'sort' のいずれかを想定",
          line: 1,
          column: 6,
          length: 4,
        },
        400,
      ),
    );
  });
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'error');
  const error = page.getByTestId('dataview-error');
  await expect(error).toContainText('クエリを解析できません (400)');
  await expect(error).toContainText('LIST form #reading');
  await expect(error).toContainText('^^^^');
  await expect(error).toContainText('1 行 6 列');
  expect(unexpected).toEqual([]);
});

test('[MOCK] クエリ API のサーバーエラー (500) もフェンス内エラーに留まり、アプリを壊さない', async ({ page }) => {
  const unexpected = await openWithJournal(page, FENCE_NOTE, 'アンカー行');
  await page.route('**/api/query', (route) => {
    void route.fulfill(json({ error: 'internal', message: 'boom' }, 500));
  });
  await editorLine(page, 'アンカー行').click();

  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'error');
  await expect(page.getByTestId('dataview-error')).toContainText('クエリを実行できませんでした');
  // エディタは通常どおり操作できる
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  expect(unexpected).toEqual([]);
});
