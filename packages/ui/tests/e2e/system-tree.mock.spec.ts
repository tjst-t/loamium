/**
 * system/ フォルダ表示トグル mock テスト (Sa10026-4)。
 *
 * AC-Sa10026-4-1: system/ はツリーで既定非表示。表示トグルで現れ再トグルで隠れる。
 * AC-Sa10026-4-2: 表示中は system/ 配下定義ファイルを通常ノートと同じ編集エディタで開ける。
 *                 GUI 並べ替えで order を再採番し PUT /api/notes/{path} で永続する。
 *
 * page.route で GET /api/notes を差し替え、system/ 配下のファイルを含む mock を返す。
 * サーバはクライアントフィルタを前提として全件返すという仕様に従い、
 * mock でも system/ ファイルを含む notes を返して UI 側のフィルタを検証する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-14';
const JOURNAL_PATH = `journals/${DATE}.md`;

// ---- フィクスチャ ----

const REGULAR_NOTES = [
  { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals', mtime: 1000 },
  { path: 'projects/hydra.md', title: 'Hydra', tags: [], folder: 'projects', mtime: 2000 },
];

const SYSTEM_NOTES = [
  {
    path: 'system/smart-folders/journal.yaml',
    title: 'journal',
    tags: [],
    folder: 'system/smart-folders',
    mtime: 3000,
  },
  {
    path: 'system/smart-folders/projects.yaml',
    title: 'projects',
    tags: [],
    folder: 'system/smart-folders',
    mtime: 3001,
  },
  {
    path: 'system/templates/journal.md',
    title: 'journal template',
    tags: [],
    folder: 'system/templates',
    mtime: 4000,
  },
  {
    path: 'system/commands/create-todo.yaml',
    title: 'create-todo',
    tags: [],
    folder: 'system/commands',
    mtime: 5000,
  },
  {
    path: 'system/settings.yaml',
    title: 'settings',
    tags: [],
    folder: 'system',
    mtime: 6000,
  },
];

const ALL_NOTES = [...REGULAR_NOTES, ...SYSTEM_NOTES];

function journalResponse(): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content: '# Journal\n',
    frontmatter: null,
    body: '# Journal\n',
    created: false,
    mtime: 1000,
  };
}

/**
 * 共通ブートストラップ:
 * - /api/notes に system/ を含む全ノートをモック
 * - /api/journal に今日のジャーナルをモック
 */
async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    // GET /api/notes (一覧) のみ差し替え、個別パスは fallback へ
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: ALL_NOTES }));
      return;
    }
    void route.fallback();
  });

  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  return unexpected;
}

// ===========================================================================
// [AC-Sa10026-4-1] 起動直後は system/ がツリーに現れない
// ===========================================================================

test('[AC-Sa10026-4-1] 起動直後は system/ がツリーに現れない (既定非表示)', async ({ page }) => {
  await boot(page);

  // tree-system-toggle が data-state="hidden" で表示されている
  const toggle = page.getByTestId('tree-system-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('data-state', 'hidden');

  // tree-system セクションは DOM に存在しない (あるいは非表示)
  await expect(page.getByTestId('tree-system')).not.toBeVisible();

  // system/ 配下のファイルは tree-item として描画されていない
  await expect(
    page.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]'),
  ).not.toBeVisible();
  await expect(
    page.locator('[data-testid="tree-item"][data-path="system/settings.yaml"]'),
  ).not.toBeVisible();

  // 通常ノートは表示されている (system でないものは影響なし)
  await expect(
    page.locator('[data-testid="tree-item"][data-path="projects/hydra.md"]'),
  ).toBeVisible();
});

// ===========================================================================
// [AC-Sa10026-4-1] トグルで system/ が現れ再トグルで隠れる
// ===========================================================================

test('[AC-Sa10026-4-1] tree-system-toggle クリックで system/ が表示され再クリックで隠れる', async ({
  page,
}) => {
  await boot(page);

  const toggle = page.getByTestId('tree-system-toggle');
  const systemSection = page.getByTestId('tree-system');

  // 初期状態: hidden
  await expect(toggle).toHaveAttribute('data-state', 'hidden');
  await expect(systemSection).not.toBeVisible();

  // 1 回クリック → shown
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'shown');
  await expect(systemSection).toBeVisible();

  // tree-system-state ラベルが「表示中」になる
  await expect(page.getByTestId('tree-system-state')).toContainText('表示中');

  // system/ 配下のファイルが visible になる
  await expect(
    page.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]'),
  ).toBeVisible();

  // 2 回クリック → hidden
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'hidden');
  await expect(systemSection).not.toBeVisible();
  await expect(page.getByTestId('tree-system-state')).toContainText('非表示');

  // system/ ファイルが非表示に戻る
  await expect(
    page.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]'),
  ).not.toBeVisible();
});

// ===========================================================================
// [AC-Sa10026-4-1] system/ ファイルは通常ツリーに混入しない
// ===========================================================================

test('[AC-Sa10026-4-1] system/ ファイルは通常 file-tree に混入しない', async ({ page }) => {
  await boot(page);

  const fileTree = page.getByTestId('file-tree');

  // system/ フォルダがツリーに現れない
  await expect(
    fileTree.locator('[data-path^="system/"]'),
  ).toHaveCount(0);

  // toggle ON しても file-tree には system/ は追加されない
  await page.getByTestId('tree-system-toggle').click();
  await expect(
    fileTree.locator('[data-path^="system/"]'),
  ).toHaveCount(0);
});

// ===========================================================================
// [AC-Sa10026-4-1] tree-system セクションのグループラベルが正しい
// ===========================================================================

test('[AC-Sa10026-4-1] tree-system-toggle ON 後、グループラベルが正しく表示される', async ({
  page,
}) => {
  await boot(page);

  await page.getByTestId('tree-system-toggle').click();
  await expect(page.getByTestId('tree-system')).toBeVisible();

  // smart-folders / templates / commands グループが表示される
  await expect(page.getByTestId('tree-system-group-smart-folders')).toBeVisible();
  await expect(page.getByTestId('tree-system-group-templates')).toBeVisible();
  await expect(page.getByTestId('tree-system-group-commands')).toBeVisible();
  // settings.yaml グループも表示される
  await expect(page.getByTestId('tree-system-group-settings')).toBeVisible();
});

// ===========================================================================
// [AC-Sa10026-4-2] 定義ファイルをクリックすると編集エディタで開く
// ===========================================================================

test('[AC-Sa10026-4-2] system/smart-folders/journal.yaml をクリックすると Editor で開く', async ({
  page,
}) => {
  const YAML_CONTENT = 'title: journal\norder: 10\nicon: 📓\nquery: journal.date = today()';

  // GET /api/notes/system/smart-folders/journal.yaml → yaml ソースを返す
  await page.route('**/api/notes/system/smart-folders/journal.yaml', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(
        json({
          path: 'system/smart-folders/journal.yaml',
          content: YAML_CONTENT,
          frontmatter: { title: 'journal', order: 10 },
          body: YAML_CONTENT,
          mtime: 3000,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await boot(page);

  // toggle ON → system/ を表示
  await page.getByTestId('tree-system-toggle').click();
  await expect(
    page.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]'),
  ).toBeVisible();

  // クリック
  await page.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]').click();

  // Editor が表示される (CommandEditor ではない)
  await expect(page.getByTestId('editor')).toBeVisible();
  // save-status が visible
  await expect(page.getByTestId('save-status')).toBeVisible();
});

test('[AC-Sa10026-4-2] system/templates/journal.md をクリックすると Editor で開く', async ({
  page,
}) => {
  const MD_CONTENT = '---\ntitle: Journal Template\norder: 10\n---\n# 今日の振り返り\n';

  await page.route('**/api/notes/system/templates/journal.md', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(
        json({
          path: 'system/templates/journal.md',
          content: MD_CONTENT,
          frontmatter: { title: 'Journal Template', order: 10 },
          body: '# 今日の振り返り\n',
          mtime: 4000,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await boot(page);

  await page.getByTestId('tree-system-toggle').click();
  await page.locator('[data-testid="tree-item"][data-path="system/templates/journal.md"]').click();

  // 通常 Editor が開く
  await expect(page.getByTestId('editor')).toBeVisible();
});

// ===========================================================================
// [AC-Sa10026-4-2] ドラッグ&ドロップ後に PUT が呼ばれる (edge: order 再採番)
// ===========================================================================

test('[AC-Sa10026-4-2] ドラッグ&ドロップ後に PUT /api/notes/{path} が order 再採番で呼ばれる', async ({
  page,
}) => {
  // smart-folders グループ内に 3 ファイル
  const NOTES_WITH_3 = [
    ...REGULAR_NOTES,
    {
      path: 'system/smart-folders/alpha.yaml',
      title: 'alpha',
      tags: [],
      folder: 'system/smart-folders',
      mtime: 3001,
    },
    {
      path: 'system/smart-folders/beta.yaml',
      title: 'beta',
      tags: [],
      folder: 'system/smart-folders',
      mtime: 3002,
    },
    {
      path: 'system/smart-folders/gamma.yaml',
      title: 'gamma',
      tags: [],
      folder: 'system/smart-folders',
      mtime: 3003,
    },
  ];

  // notes モックを上書き (3 ファイル版)
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: NOTES_WITH_3 }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });

  // 各ファイルの GET をモック
  const alphaContent = 'title: alpha\norder: 10\nquery: tag = alpha';
  const betaContent = 'title: beta\norder: 20\nquery: tag = beta';
  const gammaContent = 'title: gamma\norder: 30\nquery: tag = gamma';

  await page.route('**/api/notes/system/smart-folders/alpha.yaml', (route) => {
    const m = route.request().method();
    if (m === 'GET') {
      void route.fulfill(json({ path: 'system/smart-folders/alpha.yaml', content: alphaContent, frontmatter: { order: 10 }, body: alphaContent, mtime: 3001 }));
    } else { void route.fallback(); }
  });
  await page.route('**/api/notes/system/smart-folders/beta.yaml', (route) => {
    const m = route.request().method();
    if (m === 'GET') {
      void route.fulfill(json({ path: 'system/smart-folders/beta.yaml', content: betaContent, frontmatter: { order: 20 }, body: betaContent, mtime: 3002 }));
    } else { void route.fallback(); }
  });
  await page.route('**/api/notes/system/smart-folders/gamma.yaml', (route) => {
    const m = route.request().method();
    if (m === 'GET') {
      void route.fulfill(json({ path: 'system/smart-folders/gamma.yaml', content: gammaContent, frontmatter: { order: 30 }, body: gammaContent, mtime: 3003 }));
    } else { void route.fallback(); }
  });

  // PUT 呼び出しを記録
  const putCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/notes/system/smart-folders/alpha.yaml', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      putCalls.push({ path: 'system/smart-folders/alpha.yaml', body });
      void route.fulfill(json({ ok: true, mtime: 9999 }));
    } else { void route.fallback(); }
  });
  await page.route('**/api/notes/system/smart-folders/beta.yaml', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      putCalls.push({ path: 'system/smart-folders/beta.yaml', body });
      void route.fulfill(json({ ok: true, mtime: 9999 }));
    } else { void route.fallback(); }
  });
  await page.route('**/api/notes/system/smart-folders/gamma.yaml', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      putCalls.push({ path: 'system/smart-folders/gamma.yaml', body });
      void route.fulfill(json({ ok: true, mtime: 9999 }));
    } else { void route.fallback(); }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  // toggle ON
  await page.getByTestId('tree-system-toggle').click();
  await expect(page.getByTestId('tree-system')).toBeVisible();

  // 3 アイテムが表示される
  const alphaItem = page.locator('[data-testid="tree-item"][data-path="system/smart-folders/alpha.yaml"]');
  const betaItem = page.locator('[data-testid="tree-item"][data-path="system/smart-folders/beta.yaml"]');
  const gammaItem = page.locator('[data-testid="tree-item"][data-path="system/smart-folders/gamma.yaml"]');
  await expect(alphaItem).toBeVisible();
  await expect(betaItem).toBeVisible();
  await expect(gammaItem).toBeVisible();

  // alpha を beta の下へドラッグ (alpha が 2 番目になる → 新 order: alpha=20, beta=10, gamma=30)
  await alphaItem.dragTo(betaItem);

  // PUT が呼ばれるまで待機 (非同期 persistOrder)
  await page.waitForTimeout(500);

  // PUT が呼ばれた (少なくとも order が変わったファイル分)
  // alpha は元 order:10 → 新しい位置で 20 になるはず
  expect(putCalls.length).toBeGreaterThan(0);
  // 呼ばれた PUT body に content が含まれる
  for (const call of putCalls) {
    expect(typeof call.body['content']).toBe('string');
    expect((call.body['content'] as string)).toMatch(/order:/);
  }

  // unexpected な API 呼び出しがないことを確認
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// [MOCK] Edge: system/ のみで通常ノートが 0 件でも toggle は動作する
// ===========================================================================

test('[MOCK] 通常ノートが 0 件でも system/ トグルは機能する', async ({ page }) => {
  const unexpected = await installCatchAll(page);

  // 通常ノートなし、system/ ノートのみ
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: SYSTEM_NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  // tree-system-toggle が表示される
  const toggle = page.getByTestId('tree-system-toggle');
  await expect(toggle).toBeVisible();

  // クリックで表示できる
  await toggle.click();
  await expect(page.getByTestId('tree-system')).toBeVisible();
  await expect(page.locator('[data-testid="tree-item"][data-path="system/smart-folders/journal.yaml"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// [MOCK] Edge: system/ ノートが 0 件でも toggle ボタンは表示される
// ===========================================================================

test('[MOCK] system/ ノートが 0 件でも tree-system-toggle は表示される', async ({ page }) => {
  const unexpected = await installCatchAll(page);

  // system/ ノートなし
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: REGULAR_NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  // トグルは表示される (system/ がなくても)
  await expect(page.getByTestId('tree-system-toggle')).toBeVisible();

  // クリックすると data-state が 'shown' に変わる (中身なしでもトグル動作は正常)
  await page.getByTestId('tree-system-toggle').click();
  await expect(page.getByTestId('tree-system-toggle')).toHaveAttribute('data-state', 'shown');
  // tree-system は DOM に存在する (中身が空なので Playwright では hidden となる)
  await expect(page.getByTestId('tree-system')).toBeAttached();

  expect(unexpected).toEqual([]);
});
