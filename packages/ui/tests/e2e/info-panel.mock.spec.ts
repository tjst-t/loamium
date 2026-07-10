/**
 * Story S11493d-2 インフォパネル mock テスト。
 * page.route で /api/* をモックし、ブラウザ内 UI の振る舞いを検証する。
 * 実サーバー / vault は使わない。
 *
 * [AC-S11493d-2-1] インフォタブ / セクション折りたたみ
 * [AC-S11493d-2-2] Outline / Properties / Tags / メタ情報の表示
 * [AC-S11493d-2-3] エッジケース (空ノート / 多数見出し / frontmatter なし)
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

async function openApp(
  page: Page,
  meta?: Record<string, unknown>,
): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('本文テスト。\n')));
  });

  // installCatchAll の */meta 既定を上書き
  if (meta !== undefined) {
    await page.route('**/api/notes/**/meta', (route) => {
      void route.fulfill(json(meta));
    });
  }

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文テスト');
  return unexpected;
}

// ---- [AC-S11493d-2-1] タブ / パネル / セクション ----

test('[AC-S11493d-2-1] right-tab-info が aria-selected=true かつ info-panel が表示される', async ({
  page,
}) => {
  await openApp(page);

  await expect(page.getByTestId('right-tab-info')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('right-tab-claude')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('info-panel')).toBeVisible();
});

test('[AC-S11493d-2-1] インフォタブには 4 つの折りたたみセクションがある', async ({
  page,
}) => {
  await openApp(page, metaResp({}));

  // 各セクションのトグルが存在する
  for (const section of ['outline', 'properties', 'tags', 'meta']) {
    await expect(
      page.locator(`[data-testid="info-section-toggle"][data-section="${section}"]`),
    ).toBeAttached();
    await expect(
      page.locator(`[data-testid="info-section-body"][data-section="${section}"]`),
    ).toBeAttached();
  }
});

test('[AC-S11493d-2-1] セクションは <details> で折りたたみできる', async ({ page }) => {
  await openApp(
    page,
    metaResp({
      headings: [{ level: 2, text: '参加者', line: 3 }],
    }),
  );

  // outline セクションは既定で展開 → outline-item が見える
  const outlineBody = page.locator('[data-testid="info-section-body"][data-section="outline"]');
  await expect(outlineBody).toBeVisible();
  await expect(page.getByTestId('outline-item')).toBeVisible();

  // summary クリックで折りたたむ
  await page.locator('[data-testid="info-section-toggle"][data-section="outline"]').click();
  await expect(outlineBody).not.toBeVisible();

  // 再クリックで展開
  await page.locator('[data-testid="info-section-toggle"][data-section="outline"]').click();
  await expect(outlineBody).toBeVisible();
});

test('[AC-S11493d-2-1] ⋯ メニューが開閉できる', async ({ page }) => {
  await openApp(page);

  const menu = page.getByTestId('info-actions-menu');
  // 既定は閉じている
  await expect(menu).not.toHaveClass(/open/);

  await page.getByTestId('info-actions-btn').click();
  await expect(page.getByTestId('info-actions-btn')).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toHaveClass(/open/);

  // action items が存在する
  await expect(page.getByTestId('action-export-pdf')).toBeVisible();
  await expect(page.getByTestId('action-copy-link')).toBeVisible();
  await expect(page.getByTestId('action-copy-path')).toBeVisible();
});

// ---- [AC-S11493d-2-2] 各セクションのコンテンツ ----

test('[AC-S11493d-2-2] Outline セクションに見出しツリーが表示される', async ({ page }) => {
  await openApp(
    page,
    metaResp({
      headings: [
        { level: 1, text: 'タイトル', line: 1 },
        { level: 2, text: '参加者', line: 3 },
        { level: 2, text: '議題', line: 6 },
        { level: 3, text: 'サブセクション', line: 8 },
      ],
    }),
  );

  const items = page.getByTestId('outline-item');
  await expect(items).toHaveCount(4);

  const first = items.first();
  await expect(first).toHaveAttribute('data-line', '1');
  await expect(first).toHaveAttribute('data-level', '1');
  await expect(first).toContainText('タイトル');

  const third = items.nth(2);
  await expect(third).toHaveAttribute('data-line', '6');
  await expect(third).toHaveAttribute('data-level', '2');
  await expect(third).toContainText('議題');
});

test('[AC-S11493d-2-2] Properties セクションが frontmatter を表示し tags キーを除外する', async ({
  page,
}) => {
  await openApp(
    page,
    metaResp({
      frontmatter: {
        type: '議事録',
        date: '2026-07-10',
        status: 'draft',
        tags: ['会議', 'project-x'],
      },
    }),
  );

  const propBody = page.locator('[data-testid="info-section-body"][data-section="properties"]');
  // frontmatter があるので hidden は付かない
  await expect(
    page.locator('[data-testid="info-section-toggle"][data-section="properties"]'),
  ).toBeVisible();

  // tags キーは除外される
  await expect(propBody.locator('[data-testid="property-row"][data-key="tags"]')).not.toBeAttached();

  // その他のキーは表示
  await expect(propBody.locator('[data-testid="property-row"][data-key="type"]')).toBeVisible();
  await expect(propBody.locator('[data-testid="property-row"][data-key="date"]')).toBeVisible();
  await expect(propBody.locator('[data-testid="property-row"][data-key="status"]')).toBeVisible();
});

test('[AC-S11493d-2-2] Tags セクションが tag-chip をクリックで /search へ遷移する', async ({
  page,
}) => {
  await openApp(
    page,
    metaResp({
      tags: ['会議', 'project-x'],
    }),
  );

  const tagBody = page.locator('[data-testid="info-section-body"][data-section="tags"]');
  const chips = tagBody.getByTestId('tag-chip');
  await expect(chips).toHaveCount(2);

  const chip1 = page.locator('[data-testid="tag-chip"][data-tag="会議"]');
  await expect(chip1).toBeVisible();
  await expect(chip1).toContainText('会議');

  // クリックで /search?tag=会議 へ遷移
  await chip1.click();
  await expect(page.getByTestId('route-display')).toContainText('/search');
});

test('[AC-S11493d-2-2] メタ情報セクションに単語数 / 文字数 / 更新日時が表示される', async ({
  page,
}) => {
  await openApp(
    page,
    metaResp({
      wordCount: 148,
      charCount: 312,
      mtime: new Date('2026-07-10T14:32:00').getTime(),
    }),
  );

  await expect(page.getByTestId('meta-wordcount')).toContainText('148');
  await expect(page.getByTestId('meta-charcount')).toContainText('312');
  await expect(page.getByTestId('meta-mtime')).toContainText('2026-07-10 14:32');
});

// ---- [AC-S11493d-2-3] エッジケース ----

test('[AC-S11493d-2-3] 空ノート — 見出しなし/frontmatter なし/タグなし の empty state', async ({
  page,
}) => {
  await openApp(page, metaResp({}));

  // outline: empty state
  await expect(
    page.locator('[data-testid="info-section-body"][data-section="outline"]'),
  ).toContainText('見出しがありません');
  await expect(page.getByTestId('outline-item')).toHaveCount(0);

  // properties: frontmatter なし → hidden (toBeVisible() = false)
  const propDetails = page.locator('.info-section').filter({
    has: page.locator('[data-testid="info-section-toggle"][data-section="properties"]'),
  });
  await expect(propDetails).not.toBeVisible();

  // tags: empty state
  await expect(
    page.locator('[data-testid="info-section-body"][data-section="tags"]'),
  ).toContainText('タグなし');

  // meta: 常に表示される (wordCount=0 でも)
  await expect(page.getByTestId('meta-wordcount')).toContainText('0');
  await expect(page.getByTestId('meta-charcount')).toContainText('0');
  await expect(page.getByTestId('meta-mtime')).toBeVisible();
});

test('[AC-S11493d-2-3] 多数見出し (50 件) でも全件描画される', async ({ page }) => {
  const headings = Array.from({ length: 50 }, (_, i) => ({
    level: 2,
    text: `セクション ${String(i + 1)}`,
    line: i * 2 + 1,
  }));
  await openApp(page, metaResp({ headings }));

  await expect(page.getByTestId('outline-item')).toHaveCount(50);
  await expect(
    page.locator('[data-testid="outline-item"][data-line="1"]'),
  ).toContainText('セクション 1');
  await expect(
    page.locator('[data-testid="outline-item"][data-line="99"]'),
  ).toContainText('セクション 50');
});

test('[AC-S11493d-2-3] frontmatter のみ (tags なし) — Properties 表示 / Tags empty', async ({
  page,
}) => {
  await openApp(
    page,
    metaResp({
      frontmatter: { author: 'taro', date: '2026-07-10' },
      tags: [],
    }),
  );

  // Properties は表示
  await expect(
    page.locator('[data-testid="info-section-toggle"][data-section="properties"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="property-row"][data-key="author"]'),
  ).toBeVisible();

  // Tags は empty
  await expect(
    page.locator('[data-testid="info-section-body"][data-section="tags"]'),
  ).toContainText('タグなし');
});

test('[AC-S11493d-2-3] meta API が失敗した場合エラー表示が出る', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('本文。\n')));
  });
  // meta だけ 500 を返す
  await page.route('**/api/notes/**/meta', (route) => {
    void route.fulfill(json({ error: 'internal', message: 'boom' }, 500));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文。');
  await expect(page.getByTestId('info-panel-error')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[AC-S11493d-2-1] backlink-count バッジが 0 件時は非表示', async ({ page }) => {
  await openApp(page, metaResp({}));
  // バックリンクは mock-helpers で空で応答済み
  const badge = page.getByTestId('backlink-count');
  // バッジが DOM に存在するが非表示
  await expect(badge).toBeAttached();
  await expect(badge).not.toBeVisible();
});

// ---- [AC-S11493d-3-1] アウトゴーイングリンクセクション ----

test('[AC-S11493d-3-1] outgoing セクションが outgoingLinks を描画する (解決済み + 未解決)', async ({
  page,
}) => {
  await openApp(
    page,
    metaResp({
      outgoingLinks: [
        { target: 'project-x', resolvedPath: 'projects/project-x.md', raw: '[[project-x]]' },
        { target: 'まだ無いノート', resolvedPath: null, raw: '[[まだ無いノート]]' },
      ],
    }),
  );

  // セクション toggle + body が存在する
  await expect(
    page.locator('[data-testid="info-section-toggle"][data-section="outgoing"]'),
  ).toBeAttached();
  await expect(
    page.locator('[data-testid="info-section-body"][data-section="outgoing"]'),
  ).toBeAttached();

  // 解決済みリンク
  const resolvedLink = page.locator('[data-testid="outgoing-link"][data-target="project-x"]');
  await expect(resolvedLink).toBeVisible();
  await expect(resolvedLink).toHaveAttribute('data-resolved', 'true');
  await expect(resolvedLink).toContainText('project-x');

  // 未解決リンク — 「未解決」バッジ
  const unresolvedLink = page.locator('[data-testid="outgoing-link"][data-target="まだ無いノート"]');
  await expect(unresolvedLink).toBeVisible();
  await expect(unresolvedLink).toHaveAttribute('data-resolved', 'false');
  await expect(unresolvedLink).toContainText('未解決');
});

test('[AC-S11493d-3-1] 解決済みアウトゴーイングリンクのクリックでノートが開く', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({
      notes: [
        { path: JOURNAL_PATH, title: 'journal', tags: [], folder: 'journals' },
        { path: 'projects/project-x.md', title: 'project-x', tags: [], folder: 'projects' },
      ],
    }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('本文テスト。\n')));
  });
  await page.route('**/api/notes/**/meta', (route) => {
    void route.fulfill(json({
      ...metaResp({}),
      outgoingLinks: [
        { target: 'project-x', resolvedPath: 'projects/project-x.md', raw: '[[project-x]]' },
      ],
    }));
  });
  // project-x を GET した場合
  await page.route('**/api/notes/projects/project-x.md', (route) => {
    void route.fulfill(json({
      path: 'projects/project-x.md',
      content: '# project-x\n\n内容\n',
      frontmatter: null,
      body: '# project-x\n\n内容\n',
      mtime: 2_000_000,
    }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文テスト');

  // 解決済みリンクをクリック
  const resolvedLink = page.locator('[data-testid="outgoing-link"][data-target="project-x"]');
  await expect(resolvedLink).toBeVisible();
  await resolvedLink.click();

  // route-display が project-x を含む
  await expect(page.getByTestId('route-display')).toContainText('project-x');
  expect(unexpected).toEqual([]);
});

test('[AC-S11493d-3-1] 未解決アウトゴーイングリンクはクリックしても遷移しない', async ({
  page,
}) => {
  await openApp(
    page,
    {
      ...metaResp({}),
      outgoingLinks: [
        { target: 'まだ無いノート', resolvedPath: null, raw: '[[まだ無いノート]]' },
      ],
    },
  );

  const unresolvedLink = page.locator('[data-testid="outgoing-link"][data-target="まだ無いノート"]');
  await expect(unresolvedLink).toBeVisible();
  await expect(unresolvedLink).toHaveAttribute('data-resolved', 'false');

  // 未解決リンクは aria-disabled かつ onClick なし → クリックしても遷移しない
  await expect(unresolvedLink).toHaveAttribute('aria-disabled', 'true');
  // force:true でクリックしても route-display は変わらない
  const routeBefore = await page.getByTestId('route-display').textContent();
  await unresolvedLink.click({ force: true });
  const routeAfter = await page.getByTestId('route-display').textContent();
  expect(routeAfter).toEqual(routeBefore);
});

test('[AC-S11493d-3-1] アウトゴーイングリンクなしの場合 empty state が表示される', async ({
  page,
}) => {
  await openApp(page, metaResp({}));
  // installCatchAll の default meta は outgoingLinks: [] で応答

  const outgoingBody = page.locator('[data-testid="info-section-body"][data-section="outgoing"]');
  await expect(outgoingBody).toContainText('[[リンク]] なし');
  await expect(page.getByTestId('outgoing-link')).toHaveCount(0);
});

// ---- [AC-S11493d-3-2] バックリンクセクション統合 ----

test('[AC-S11493d-3-2] バックリンクが info-section[backlinks] 内に表示される', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('本文テスト。\n')));
  });
  await page.route('**/api/backlinks*', (route) => {
    void route.fulfill(json({
      path: JOURNAL_PATH,
      backlinks: [
        {
          source: 'weekly/週次.md',
          links: [{ raw: `[[${JOURNAL_PATH}]]`, heading: null, line: 3, context: `参照: [[${JOURNAL_PATH}]]` }],
        },
      ],
    }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文テスト');

  // backlink-count バッジが出るまで待つ (backlinks 取得完了の合図)
  await expect(page.getByTestId('backlink-count')).toBeVisible({ timeout: 5_000 });

  // backlinks セクション toggle/body が存在する
  await expect(
    page.locator('[data-testid="info-section-toggle"][data-section="backlinks"]'),
  ).toBeAttached();
  await expect(
    page.locator('[data-testid="info-section-body"][data-section="backlinks"]'),
  ).toBeAttached();

  // backlink-item が section 内に表示される
  const backlinkBody = page.locator('[data-testid="info-section-body"][data-section="backlinks"]');
  await expect(backlinkBody.getByTestId('backlink-item')).toHaveCount(1);
  await expect(backlinkBody.locator('[data-testid="backlink-item"][data-source="weekly/週次.md"]')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[AC-S11493d-3-2] バックリンクゼロのとき backlink-empty が section 内に表示される', async ({
  page,
}) => {
  await openApp(page, metaResp({}));
  // mock-helpers の default で backlinks: [] が返る

  const backlinkBody = page.locator('[data-testid="info-section-body"][data-section="backlinks"]');
  await expect(backlinkBody.getByTestId('backlink-empty')).toBeVisible();
});

test('[AC-S11493d-3-2] バックリンクエラー時 backlink-error が section 内に表示される', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('本文テスト。\n')));
  });
  await page.route('**/api/backlinks*', (route) => {
    void route.fulfill(json({ error: 'internal', message: 'boom' }, 500));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文テスト');

  const backlinkBody = page.locator('[data-testid="info-section-body"][data-section="backlinks"]');
  await expect(backlinkBody.getByTestId('backlink-error')).toBeVisible();
  await expect(backlinkBody.getByTestId('backlink-error')).toContainText('取得できませんでした');
  expect(unexpected).toEqual([]);
});

// ---- [AC-S11493d-3-3] バッジカウントは right-tab-info に残る ----

test('[AC-S11493d-3-3] backlink-count バッジが right-tab-info に表示される', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('本文テスト。\n')));
  });
  await page.route('**/api/backlinks*', (route) => {
    void route.fulfill(json({
      path: JOURNAL_PATH,
      backlinks: [
        {
          source: 'a.md',
          links: [{ raw: '[[x]]', heading: null, line: 1, context: '[[x]]' }],
        },
        {
          source: 'b.md',
          links: [{ raw: '[[x]]', heading: null, line: 2, context: '[[x]]' }],
        },
      ],
    }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('本文テスト');

  // backlink-count バッジが right-tab-info 内にある (backlinks 取得完了後)
  const tabInfo = page.getByTestId('right-tab-info');
  const badge = tabInfo.getByTestId('backlink-count');
  await expect(badge).toBeVisible({ timeout: 5_000 });
  await expect(badge).toHaveText('2');
  expect(unexpected).toEqual([]);
});
