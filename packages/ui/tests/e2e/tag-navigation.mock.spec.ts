/**
 * Story S11493d-4 mock テスト: タグクリック → タグ検索ナビゲーション
 *
 * page.route で全 /api/* をモックし、各タグ表示箇所でのクリック → /search?tag=
 * ナビゲーションを検証する。実サーバー / vault は使わない。
 *
 * [AC-S11493d-4-1] 共有 makeTagClickHandler が全タグ表示箇所に適用されている
 * [AC-S11493d-4-2] ナビゲーション先が /search?tag=<tag> (URL クエリ同期)
 * [AC-S11493d-4-3] エッジケース: 日本語タグ / 特殊文字タグ / 複数タグ / InfoPanel Tags
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-10';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1_000_000,
  };
}

function metaResp(overrides: Partial<{
  path: string;
  headings: { level: number; text: string; line: number }[];
  outgoingLinks: { target: string; resolvedPath: string | null; raw: string }[];
  tags: string[];
  frontmatter: Record<string, unknown> | null;
  mtime: number;
  wordCount: number;
  charCount: number;
}>): Record<string, unknown> {
  return {
    path: overrides.path ?? JOURNAL_PATH,
    headings: overrides.headings ?? [],
    outgoingLinks: overrides.outgoingLinks ?? [],
    tags: overrides.tags ?? [],
    frontmatter: overrides.frontmatter !== undefined ? overrides.frontmatter : null,
    mtime: overrides.mtime ?? 1_720_569_120_000,
    wordCount: overrides.wordCount ?? 0,
    charCount: overrides.charCount ?? 0,
  };
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

/** アプリを開き、指定ノートとメタ情報をモックする */
async function openApp(
  page: Page,
  opts: {
    content?: string;
    meta?: Record<string, unknown>;
    notePutResponse?: Record<string, unknown>;
  } = {},
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  const content = opts.content ?? '本文テスト。\n';

  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  if (opts.notePutResponse !== undefined) {
    const putResp = opts.notePutResponse;
    await page.route(`**/api/notes/journals/**`, (route) => {
      if (route.request().method() === 'PUT') {
        void route.fulfill(json(putResp));
        return;
      }
      void route.fulfill(json(journal(content)));
    });
  } else {
    await page.route(`**/api/notes/journals/**`, (route) => {
      if (route.request().method() === 'PUT') {
        void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
        return;
      }
      void route.fulfill(json(journal(content)));
    });
  }

  if (opts.meta !== undefined) {
    const meta = opts.meta;
    await page.route('**/api/notes/**/meta', (route) => {
      void route.fulfill(json(meta));
    });
  }

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文テスト');
  return unexpected;
}

// ---- [AC-S11493d-4-1/2] InfoPanel Tags セクションのタグクリック ----

test('[AC-S11493d-4-1][AC-S11493d-4-2] InfoPanel Tags チップクリックで /search?tag= へ遷移', async ({
  page,
}) => {
  await openApp(page, {
    meta: metaResp({ tags: ['project', 'infra'] }),
  });

  const tagBody = page.locator('[data-testid="info-section-body"][data-section="tags"]');
  const chip = tagBody.locator('[data-testid="tag-chip"][data-tag="project"]');
  await expect(chip).toBeVisible();

  await chip.click();

  // /search?tag=project へ遷移したことを route-display で確認
  await expect(page.getByTestId('route-display')).toContainText('/search');
  await expect(page).toHaveURL(/[?&]tag=project/);
});

test('[AC-S11493d-4-2] InfoPanel tag-chip クリック後に SearchPage が tag フィルタ付きで表示される', async ({
  page,
}) => {
  // search の route をモック
  await page.route('**/api/search*', (route) => {
    void route.fulfill(json({ results: [] }));
  });

  await openApp(page, {
    meta: metaResp({ tags: ['プロジェクト'] }),
  });

  const chip = page.locator('[data-testid="tag-chip"][data-tag="プロジェクト"]');
  await expect(chip).toBeVisible();
  await chip.click();

  // SearchPage が表示される
  await expect(page).toHaveURL(/[?&]tag=%E3%83%97%E3%83%AD%E3%82%B8%E3%82%A7%E3%82%AF%E3%83%88/);
  await expect(page.getByTestId('route-display')).toContainText('/search');
});

// ---- [AC-S11493d-4-3] エッジケース ----

test('[AC-S11493d-4-3] 複数タグが独立してクリック可能で、それぞれ正しい tag= クエリで遷移', async ({
  page,
}) => {
  await openApp(page, {
    meta: metaResp({ tags: ['alpha', 'beta', 'gamma'] }),
  });

  const tagBody = page.locator('[data-testid="info-section-body"][data-section="tags"]');
  const chips = tagBody.getByTestId('tag-chip');
  await expect(chips).toHaveCount(3);

  // beta をクリック
  await chips.nth(1).click();
  await expect(page).toHaveURL(/[?&]tag=beta/);
});

test('[AC-S11493d-4-3] 日本語タグが URL エンコードされて /search?tag= へ遷移する', async ({
  page,
}) => {
  await openApp(page, {
    meta: metaResp({ tags: ['会議録', 'プロジェクト'] }),
  });

  const chip = page.locator('[data-testid="tag-chip"][data-tag="会議録"]');
  await expect(chip).toBeVisible();
  await chip.click();

  // URL エンコードされていることを確認
  await expect(page).toHaveURL(/[?&]tag=%E4%BC%9A%E8%AD%B0%E9%8C%B2/);
});

test('[AC-S11493d-4-3] InfoPanel Tags: タグなし状態では empty state が表示される', async ({
  page,
}) => {
  await openApp(page, {
    meta: metaResp({ tags: [] }),
  });

  const tagBody = page.locator('[data-testid="info-section-body"][data-section="tags"]');
  await expect(tagBody).toContainText('タグなし');
  await expect(tagBody.getByTestId('tag-chip')).toHaveCount(0);
});

// ---- properties.ts の tag チップ ----

test('[AC-S11493d-4-1][AC-S11493d-4-2] properties.ts タグチップクリックで /search?tag= へ遷移', async ({
  page,
}) => {
  const FM_NOTE = [
    '---',
    'tags: [project, infra]',
    'status: active',
    '---',
    '',
    '本文テスト。',
    '',
  ].join('\n');

  await openApp(page, {
    content: FM_NOTE,
    meta: metaResp({
      tags: ['project', 'infra'],
      frontmatter: { tags: ['project', 'infra'], status: 'active' },
    }),
  });

  // frontmatter がある → properties-widget が表示される
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();

  // tags チップが描画されるまで待つ (widget が畳まれている可能性があるため展開)
  const toggle = widget.getByTestId('properties-toggle');
  const isOpen = await widget.getAttribute('data-open');
  if (isOpen !== 'true') {
    await toggle.click();
    await expect(widget).toHaveAttribute('data-open', 'true');
  }

  // 'project' タグのチップをクリック
  const tagChip = widget.locator('[data-testid="properties-chip"][data-value="project"]');
  await expect(tagChip).toBeVisible();
  await tagChip.click();

  await expect(page.getByTestId('route-display')).toContainText('/search');
  await expect(page).toHaveURL(/[?&]tag=project/);
});

// ---- dataview.ts の dv-tag チップ ----

test('[AC-S11493d-4-1][AC-S11493d-4-2] dataview TABLE の dv-tag チップクリックで /search?tag= へ遷移', async ({
  page,
}) => {
  const FENCE_NOTE = [
    '```dataview',
    'TABLE tags from ""',
    '```',
    '',
    '本文テスト。',
    '',
  ].join('\n');

  await openApp(page, { content: FENCE_NOTE });

  await page.route('**/api/query', (route) => {
    void route.fulfill(
      json({
        type: 'table',
        fields: ['tags'],
        results: [
          { path: 'notes/a.md', title: 'a', folder: 'notes', values: [['project', 'work']] },
        ],
      }),
    );
  });

  // エディタ内でフェンス外の行をクリックしてフェンスをウィジェット化
  await editorLine(page, '本文テスト').click();

  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'table');

  // dv-tag チップが描画されるまで待つ
  const tagChip = widget.locator('[data-testid="dataview-tag"][data-tag="project"]');
  await expect(tagChip).toBeVisible();

  // mousedown でナビゲーション (wireNavigation と同じ挙動)
  await tagChip.click({ force: true });

  await expect(page.getByTestId('route-display')).toContainText('/search');
  await expect(page).toHaveURL(/[?&]tag=project/);
});
