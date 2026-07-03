/**
 * Story S6fbf45-2 mock テスト (バックリンクパネルのエッジ・エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-S6fbf45-2.json 参照)。
 * 受け入れ条件の本検証は backlinks-panel.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

const BACKLINKS = {
  path: JOURNAL_PATH,
  backlinks: [
    {
      source: '週次レビュー.md',
      links: [
        {
          raw: `[[${DATE}]]`,
          heading: null,
          line: 3,
          context: `来週分: [[${DATE}]] にバックリンクパネルの実装着手を割り当てる`,
        },
      ],
    },
    {
      source: 'projects/Loamium 開発ログ.md',
      links: [
        {
          raw: `[[${DATE}#メモ]]`,
          heading: 'メモ',
          line: 8,
          context: `Sprint S6fbf45 の進捗は [[${DATE}#メモ]] のジャーナルに記録する`,
        },
      ],
    },
  ],
};

function journal(content: string): Record<string, unknown> {
  return { date: DATE, path: JOURNAL_PATH, content, frontmatter: null, body: content, created: false, mtime: 1000 };
}

async function openApp(page: Page, opts: { backlinks?: unknown; failBacklinks?: boolean } = {}): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
          { path: '週次レビュー.md', title: '週次レビュー', tags: [], folder: '' },
        ],
      }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  if (opts.backlinks !== undefined || opts.failBacklinks === true) {
    await page.route('**/api/backlinks*', (route) => {
      if (opts.failBacklinks === true) {
        void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
        return;
      }
      void route.fulfill(json(opts.backlinks));
    });
  }
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  return unexpected;
}

test('[MOCK] 参照元 + コンテキスト行が表示され、件数バッジがリンク数と一致し、リンク原文が mark 強調される', async ({ page }) => {
  const unexpected = await openApp(page, { backlinks: BACKLINKS });

  await expect(page.getByTestId('backlink-count')).toHaveText('2');
  const items = page.getByTestId('backlink-item');
  await expect(items).toHaveCount(2);
  const first = page.locator('[data-testid="backlink-item"][data-source="週次レビュー.md"]');
  await expect(first).toContainText('週次レビュー');
  await expect(first).toContainText('来週分:');
  await expect(first.locator('mark')).toHaveText(`[[${DATE}]]`);
  // heading 付きリンクも原文どおりコンテキスト表示される
  const second = page.locator('[data-testid="backlink-item"][data-source="projects/Loamium 開発ログ.md"]');
  await expect(second).toContainText('Loamium 開発ログ');
  await expect(second.locator('mark')).toHaveText(`[[${DATE}#メモ]]`);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 参照元 0 件では backlink-empty と件数 0 を表示する', async ({ page }) => {
  const unexpected = await openApp(page); // installCatchAll の既定 (空バックリンク)

  await expect(page.getByTestId('backlink-empty')).toBeVisible();
  await expect(page.getByTestId('backlink-count')).toHaveText('0');
  await expect(page.getByTestId('backlink-item')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] バックリンク取得失敗はパネル内エラー表示に留まり、エディタは編集可能なまま', async ({ page }) => {
  const unexpected = await openApp(page, { failBacklinks: true });

  await expect(page.getByTestId('backlink-error')).toBeVisible();
  await expect(page.getByTestId('backlink-error')).toContainText('取得できませんでした');
  await expect(page.getByTestId('backlink-count')).toHaveCount(0);
  // エディタは阻害されない
  await page.locator('[data-testid="editor"] .cm-line', { hasText: '本文。' }).first().click();
  await page.keyboard.type('追記');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 保存 (PUT 成功) でバックリンクが再取得される', async ({ page }) => {
  let calls = 0;
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# ジャーナル\n\n本文。\n')));
  });
  await page.route(`**/api/notes/journals/**`, (route) => {
    void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
  });
  await page.route('**/api/backlinks*', (route) => {
    calls += 1;
    // 2 回目以降 (保存後) は参照元が増えている
    void route.fulfill(json(calls >= 2 ? BACKLINKS : { path: JOURNAL_PATH, backlinks: [] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  await expect(page.getByTestId('backlink-empty')).toBeVisible();

  // 編集して保存 → 再取得され、パネルが更新される
  await page.locator('[data-testid="editor"] .cm-line', { hasText: '本文。' }).first().click();
  await page.keyboard.type('追記して保存。');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('backlink-item')).toHaveCount(2);
  await expect(page.getByTestId('backlink-count')).toHaveText('2');
  expect(unexpected).toEqual([]);
});

test('[MOCK] パネルの開閉トグルで折りたたみ・復帰できる', async ({ page }) => {
  const unexpected = await openApp(page, { backlinks: BACKLINKS });

  await expect(page.getByTestId('backlink-item')).toHaveCount(2);
  await page.getByTestId('backlink-panel-toggle').click();
  await expect(page.getByTestId('backlink-panel')).toHaveClass(/collapsed/);
  await expect(page.getByTestId('backlink-item')).toHaveCount(0);
  await page.getByTestId('backlink-panel-toggle').click();
  await expect(page.getByTestId('backlink-panel')).not.toHaveClass(/collapsed/);
  await expect(page.getByTestId('backlink-item')).toHaveCount(2);
  expect(unexpected).toEqual([]);
});
