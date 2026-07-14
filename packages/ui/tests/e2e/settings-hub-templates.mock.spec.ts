/**
 * 設定ハブ テンプレート管理 mock テスト (Sa100c6-1)。
 *
 * page.route で API をモックし、ブラウザ上で UI の動作を検証する。
 * サーバーは起動しない。
 *
 * [AC-Sa100c6-1-1] 左ナビ 2 グループ + コンテンツ各セクション master-detail。settings-link 撤去。
 * [AC-Sa100c6-1-2] テンプレ一覧・絞り込み・新規・複製・削除 + 本文編集 + 保存。
 * [AC-Sa100c6-1-3] 保存/削除/作成は監査ログ + LOAMIUM_MODE クランプ + agent 非公開。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-14';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journalResponse(): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content: '',
    frontmatter: null,
    body: '',
    created: false,
    mtime: 1000,
  };
}

const NOTES = [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals', mtime: 1000 }];

const TEMPLATE_FILES = [
  { path: 'system/templates/journal.md', size: 120, mtime: 1000 },
  { path: 'system/templates/議事録.md', size: 80, mtime: 1001 },
  { path: 'system/templates/読書メモ.md', size: 60, mtime: 1002 },
];

const JOURNAL_TMPL_CONTENT =
  '---\ntags: []\n---\n# {{date:YYYY-MM-DD}}\n\n## 今日の予定\n- [ ] \n';

/** 共通ブートストラップ: templates を含む system-files mock を追加 */
async function boot(page: Page, opts?: {
  mode?: 'full' | 'read-only' | 'append-only';
  systemFiles?: Array<{ path: string; size: number; mtime: number }>;
}): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  const mode = opts?.mode ?? 'full';
  const systemFiles = opts?.systemFiles ?? TEMPLATE_FILES;

  // health (mode 制御)
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({
      status: 'ok',
      mode,
      agent: { enabled: false, reason: 'not_configured' },
    }));
  });

  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });

  // system-files 一覧
  await page.route('**/api/system-files', (route) => {
    // source の読み書きパスは別
    if (route.request().url().includes('/source')) {
      void route.fallback();
      return;
    }
    void route.fulfill(json({ files: systemFiles }));
  });

  // system-files source 読み取り
  await page.route('**/api/system-files/**/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({
        path: 'system/templates/journal.md',
        content: JOURNAL_TMPL_CONTENT,
        mtime: 1000,
      }));
    } else if (method === 'PUT') {
      void route.fulfill(json({ path: 'system/templates/journal.md', created: false, mtime: 2000 }));
    } else if (method === 'DELETE') {
      void route.fulfill(json({ path: 'system/templates/journal.md', deleted: true }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  return unexpected;
}

/** 設定画面を開き templates タブへ遷移 */
async function openTemplatesTab(page: Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="templates"]').click();
}

// ============================================================
// [AC-Sa100c6-1-1] 左ナビ 2 グループ確認 + settings-link 撤去
// ============================================================

test('[AC-Sa100c6-1-1] 左ナビに設定グループ(general/agent/privacy)とコンテンツグループ(templates/smart-folders/commands)が存在する', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // 設定グループ
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="general"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="agent"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="privacy"]')).toBeVisible();

  // コンテンツグループ
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="templates"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="commands"]')).toBeVisible();
});

test('[AC-Sa100c6-1-1] settings-link が存在しない (撤去済み)', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // settings-link は存在しない
  await expect(page.locator('[data-testid="settings-link"]')).toHaveCount(0);
});

test('[AC-Sa100c6-1-1] テンプレートタブをクリックすると master-detail が表示される', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  // md-panel が visible
  await expect(page.locator('[data-testid="md-panel"][data-group="templates"]')).toBeVisible();

  // 左マスター
  await expect(page.locator('[data-testid="md-master"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-items"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-filter"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-new"]')).toBeVisible();
});

test('[AC-Sa100c6-1-1] スマートフォルダタブはプレースホルダを表示する (Sa100c6-2 未実装)', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]').click();

  await expect(page.locator('[data-testid="md-panel"][data-group="smart-folders"]')).toBeVisible();
});

test('[AC-Sa100c6-1-1] スマートコマンドタブはプレースホルダを表示する (Sa100c6-3 未実装)', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="commands"]').click();

  await expect(page.locator('[data-testid="md-panel"][data-group="commands"]')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-1-1] 既存 設定グループのパネルは壊れていない
// ============================================================

test('[AC-Sa100c6-1-1] 設定グループ(general)パネルは引き続き表示される', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();

  // general は初期アクティブ
  await expect(page.locator('[data-testid="settings-panel"][data-group="general"]')).toBeVisible();
});

test('[AC-Sa100c6-1-1] エージェントパネルが引き続き正常に動作する', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();
  // 接続テストボタンが存在する
  await expect(page.getByTestId('settings-conn-test')).toBeVisible();
});

test('[AC-Sa100c6-1-1] プライバシーパネルが引き続き正常に動作する', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();

  await expect(page.locator('[data-testid="settings-panel"][data-group="privacy"]')).toBeVisible();
  await expect(page.getByTestId('deny-list')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-1-2] テンプレート一覧と選択
// ============================================================

test('[AC-Sa100c6-1-2] テンプレート一覧に md-item が並ぶ', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  // 3 件のテンプレートが一覧に出る
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);

  // journal が存在する
  await expect(page.locator('[data-testid="md-item"][data-id="journal"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="議事録"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="読書メモ"]')).toBeVisible();
});

test('[AC-Sa100c6-1-2] md-item をクリックすると md-detail にタイトルヘッダが表示される', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  // 最初のアイテムが選択されるのを待つ
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

  // journal をクリック
  await page.locator('[data-testid="md-item"][data-id="journal"]').click();

  // タイトルヘッダが detail-title に反映
  await expect(page.getByTestId('detail-title')).toHaveValue('journal');
  await expect(page.getByTestId('detail-path')).toContainText('system/templates/journal.md');
});

test('[AC-Sa100c6-1-2] template-editor が表示される', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  // CodeMirror エディタラッパーが visible
  await expect(page.getByTestId('template-editor')).toBeVisible({ timeout: 5000 });
});

test('[AC-Sa100c6-1-2] md-detail-footer にフッタボタンが揃っている', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  // フッタが表示される
  await expect(page.getByTestId('md-detail-footer')).toBeVisible({ timeout: 5000 });

  // 保存/キャンセル/複製/削除
  await expect(page.getByTestId('md-save')).toBeVisible();
  await expect(page.getByTestId('md-cancel')).toBeVisible();
  await expect(page.getByTestId('md-duplicate')).toBeVisible();
  await expect(page.getByTestId('md-delete')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-1-2] 絞り込み
// ============================================================

test('[AC-Sa100c6-1-2] md-filter 入力で絞り込みができる', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  // 3 件存在を確認
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);

  // '議事' で絞り込み
  await page.getByTestId('md-filter-input').fill('議事');

  // 議事録のみ visible、他は hidden
  await expect(page.locator('[data-testid="md-item"][data-id="議事録"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="journal"]')).not.toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="読書メモ"]')).not.toBeVisible();
});

test('[AC-Sa100c6-1-2] 絞り込みをクリアすると全件戻る', async ({ page }) => {
  await boot(page);
  await openTemplatesTab(page);

  await page.getByTestId('md-filter-input').fill('議事');
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(1);

  await page.getByTestId('md-filter-input').fill('');
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);
});

// ============================================================
// [AC-Sa100c6-1-2] 保存
// ============================================================

test('[AC-Sa100c6-1-2] 保存ボタンクリックで PUT /api/system-files/{path}/source が呼ばれる', async ({ page }) => {
  const putCalls: Array<{ url: string; body: unknown }> = [];

  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }));
  });
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });
  await page.route('**/api/system-files', (route) => {
    if (route.request().url().includes('/source')) { void route.fallback(); return; }
    void route.fulfill(json({ files: TEMPLATE_FILES }));
  });
  await page.route('**/api/system-files/**/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ path: 'system/templates/journal.md', content: JOURNAL_TMPL_CONTENT, mtime: 1000 }));
    } else if (method === 'PUT') {
      putCalls.push({ url: route.request().url(), body: route.request().postDataJSON() });
      void route.fulfill(json({ path: 'system/templates/journal.md', created: false, mtime: 2000 }));
    } else if (method === 'DELETE') {
      void route.fulfill(json({ path: 'system/templates/journal.md', deleted: true }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await openTemplatesTab(page);

  // journal アイテムが選択されるまで待つ
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('md-save')).toBeVisible();

  // 保存ボタンをクリック
  await page.getByTestId('md-save').click();

  // PUT が呼ばれた
  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  // PUT URL に system/templates/journal.md が含まれる (パスセグメントは / で区切られる)
  expect(putCalls[0]?.url).toContain('system/templates/journal.md');

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa100c6-1-2] 新規作成
// ============================================================

test('[AC-Sa100c6-1-2] md-new クリックで新規テンプレートが作成される', async ({ page }) => {
  const putCalls: string[] = [];

  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }));
  });
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });

  let systemFileCount = TEMPLATE_FILES.length;
  await page.route('**/api/system-files', (route) => {
    if (route.request().url().includes('/source')) { void route.fallback(); return; }
    // 最初は 3 件、PUT 後に 4 件返す
    const files = systemFileCount > TEMPLATE_FILES.length
      ? [...TEMPLATE_FILES, { path: 'system/templates/新しいテンプレート.md', size: 20, mtime: 3000 }]
      : TEMPLATE_FILES;
    void route.fulfill(json({ files }));
  });
  await page.route('**/api/system-files/**/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ path: 'system/templates/journal.md', content: JOURNAL_TMPL_CONTENT, mtime: 1000 }));
    } else if (method === 'PUT') {
      putCalls.push(route.request().url());
      systemFileCount++;
      void route.fulfill(json({ path: route.request().url(), created: true, mtime: 3000 }));
    } else if (method === 'DELETE') {
      void route.fulfill(json({ path: 'system/templates/journal.md', deleted: true }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await openTemplatesTab(page);

  // 新規ボタンをクリック
  await page.getByTestId('md-new').click();

  // PUT が呼ばれた
  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa100c6-1-3] read-only モードで書込 UI が disabled
// ============================================================

test('[AC-Sa100c6-1-3] read-only モードでは保存/複製/削除/新規ボタンが disabled', async ({ page }) => {
  await boot(page, { mode: 'read-only' });
  await openTemplatesTab(page);

  // detail-footer が表示されるまで待つ
  await expect(page.getByTestId('md-detail-footer')).toBeVisible({ timeout: 5000 });

  await expect(page.getByTestId('md-new')).toBeDisabled();
  await expect(page.getByTestId('md-save')).toBeDisabled();
  await expect(page.getByTestId('md-duplicate')).toBeDisabled();
  await expect(page.getByTestId('md-delete')).toBeDisabled();
});

// ============================================================
// 既存: settings-view のエージェント/プライバシーが壊れていない
// ============================================================

test('[COMPAT] 既存の接続テストボタンが動作する', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }));
  });
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) { void route.fulfill(json({ notes: NOTES })); return; }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });
  await page.route('**/api/system-files', (route) => {
    if (route.request().url().includes('/source')) { void route.fallback(); return; }
    void route.fulfill(json({ files: [] }));
  });
  await page.route('**/api/settings/agent/connection/test', (route) => {
    void route.fulfill(json({ ok: true, model: 'claude-sonnet-4-6', latencyMs: 100 }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await page.getByTestId('settings-conn-test').click();

  await expect(page.getByTestId('settings-conn-result')).toHaveAttribute('data-state', 'ok');

  expect(unexpected).toEqual([]);
});

test('[COMPAT] 既存の deny-list 追加が動作する', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: 'not_configured' } }));
  });
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) { void route.fulfill(json({ notes: NOTES })); return; }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journalResponse()));
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });
  await page.route('**/api/system-files', (route) => {
    if (route.request().url().includes('/source')) { void route.fallback(); return; }
    void route.fulfill(json({ files: [] }));
  });
  await page.route('**/api/settings/agent/privacy', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ deny: ['private/**'] }));
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON() as { deny: string[] };
      void route.fulfill(json({ deny: body.deny }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();

  await expect(page.locator('[data-testid="deny-entry"][data-value="private/**"]')).toBeVisible();
  await page.getByTestId('deny-add-input').fill('extra/**');
  await page.getByTestId('deny-add').click();
  await expect(page.locator('[data-testid="deny-entry"][data-value="extra/**"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});
