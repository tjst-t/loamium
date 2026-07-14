/**
 * 設定ハブ スマートフォルダ管理 mock テスト (Sa100c6-2)。
 *
 * page.route で API をモックし、ブラウザ上で UI の動作を検証する。
 * サーバーは起動しない。
 *
 * [AC-Sa100c6-2-1] 一覧(絞り込み・ドラッグ並べ替え)・新規・削除・選択→SmartFolderForm編集→保存。
 * [AC-Sa100c6-2-2] 並べ替えは order 再採番で永続。保存/削除は監査 + LOAMIUM_MODEクランプ。
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

/** スマートフォルダのテストデータ (DQL は parseQuery を通る最小限の文字列) */
const SF_ITEMS = [
  { kind: 'query', id: 'journal-sf', name: 'ジャーナル', icon: 'calendar', dql: 'LIST' },
  { kind: 'query', id: 'recent-sf', name: '最近', icon: 'clock', dql: 'LIST' },
  { kind: 'pin', id: 'notes-pin', path: 'notes/test.md', name: 'ノート' },
];

/** 共通ブートストラップ */
async function boot(page: Page, opts?: {
  mode?: 'full' | 'read-only' | 'append-only';
  sfItems?: unknown[];
}): Promise<{ unexpected: string[]; putCalls: Array<{ url: string; body: unknown }> }> {
  const unexpected = await installCatchAll(page);
  const mode = opts?.mode ?? 'full';
  const sfItems = opts?.sfItems ?? SF_ITEMS;
  const putCalls: Array<{ url: string; body: unknown }> = [];

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

  // スマートフォルダ CRUD
  await page.route('**/api/smart-folders', (route) => {
    const url = route.request().url();
    // /notes サブリソースはフォールバック
    if (url.includes('/notes')) {
      void route.fallback();
      return;
    }
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ version: 1, items: sfItems }));
    } else if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      putCalls.push({ url, body });
      void route.fulfill(json({ version: 1, items: (body as { items: unknown[] }).items }));
    } else {
      void route.fallback();
    }
  });

  // system-files (テンプレート用)
  await page.route('**/api/system-files', (route) => {
    if (route.request().url().includes('/source')) { void route.fallback(); return; }
    void route.fulfill(json({ files: [] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  return { unexpected, putCalls };
}

/** 設定画面を開き smart-folders タブへ遷移 */
async function openSFTab(page: Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]').click();
  await expect(page.locator('[data-testid="md-panel"][data-group="smart-folders"]')).toBeVisible();
}

// ============================================================
// [AC-Sa100c6-2-1] master-detail 基本構造
// ============================================================

test('[AC-Sa100c6-2-1] スマートフォルダタブで master-detail が表示される', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  // md-panel[data-group=smart-folders] が visible
  await expect(page.locator('[data-testid="md-panel"][data-group="smart-folders"]')).toBeVisible();

  // 左マスター
  await expect(page.locator('[data-testid="md-master"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-items"][data-items="smart-folders"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-filter"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-new"]')).toBeVisible();
});

test('[AC-Sa100c6-2-1] 一覧に md-item が並ぶ (journal-sf / recent-sf / notes-pin)', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="md-item"][data-id="journal-sf"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="recent-sf"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="notes-pin"]')).toBeVisible();
});

test('[AC-Sa100c6-2-1] md-item をクリックすると md-detail に SmartFolderForm が表示される', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  // 最初のアイテムが自動選択されるまで待つ
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

  // recent-sf をクリック
  await page.locator('[data-testid="md-item"][data-id="recent-sf"]').click();

  // detail-title に名前が表示される
  await expect(page.getByTestId('detail-title')).toHaveValue('最近');

  // SmartFolderForm が表示される
  await expect(page.getByTestId('sf-form')).toBeVisible();

  // sf-form-name
  await expect(page.getByTestId('sf-form-name')).toBeVisible();

  // sf-form-kind-query が active (query タイプ)
  await expect(page.getByTestId('sf-form-kind-query')).toHaveAttribute('aria-pressed', 'true');

  // sf-form-dql が表示される
  await expect(page.getByTestId('sf-form-dql')).toBeVisible();
});

test('[AC-Sa100c6-2-1] detail-path にファイルパスが表示される', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="journal-sf"]').click();

  await expect(page.getByTestId('detail-path')).toContainText('system/smart-folders/journal-sf.yaml');
});

test('[AC-Sa100c6-2-1] フッタに保存/キャンセル/削除ボタンが表示される', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  await expect(page.getByTestId('md-detail-footer')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('md-save')).toBeVisible();
  await expect(page.getByTestId('md-cancel')).toBeVisible();
  await expect(page.getByTestId('md-delete')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-2-1] 絞り込み
// ============================================================

test('[AC-Sa100c6-2-1] md-filter 入力で絞り込みができる', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);

  // 'ジャーナル' で絞り込み
  await page.getByTestId('md-filter-input').fill('ジャーナル');

  // journal-sf のみ visible
  await expect(page.locator('[data-testid="md-item"][data-id="journal-sf"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="recent-sf"]')).not.toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="notes-pin"]')).not.toBeVisible();
});

test('[AC-Sa100c6-2-1] 絞り込みをクリアすると全件戻る', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  await page.getByTestId('md-filter-input').fill('ジャーナル');
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(1);

  await page.getByTestId('md-filter-input').fill('');
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);
});

// ============================================================
// [AC-Sa100c6-2-1] 保存: フッタの保存ボタン → PUT /api/smart-folders
// ============================================================

test('[AC-Sa100c6-2-1] 保存ボタンクリックで PUT /api/smart-folders が呼ばれる', async ({ page }) => {
  const { putCalls } = await boot(page);
  await openSFTab(page);

  // journal-sf を選択
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="journal-sf"]').click();

  // DQL を変更
  await page.getByTestId('sf-form-dql').fill('LIST FROM "journals" SORT file.name DESC LIMIT 5');

  // 保存ボタンをクリック
  await page.getByTestId('md-save').click();

  // PUT が呼ばれた
  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  // PUT URL
  expect(putCalls[0]?.url).toContain('/api/smart-folders');
});

test('[AC-Sa100c6-2-1] タイトルヘッダ編集で名前が更新される', async ({ page }) => {
  const { putCalls } = await boot(page);
  await openSFTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="journal-sf"]').click();

  // タイトルを変更
  await page.getByTestId('detail-title').fill('ジャーナル(改)');

  // 保存
  await page.getByTestId('md-save').click();

  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  // PUT body に新しい名前が含まれる
  const body = putCalls[0]?.body as { items: Array<{ id: string; name: string }> };
  const updatedItem = body.items.find((i) => i.id === 'journal-sf');
  expect(updatedItem?.name).toBe('ジャーナル(改)');
});

// ============================================================
// [AC-Sa100c6-2-1] 新規作成
// ============================================================

test('[AC-Sa100c6-2-1] md-new クリックで新規スマートフォルダが作成される', async ({ page }) => {
  const { putCalls } = await boot(page);
  await openSFTab(page);

  // 新規ボタンをクリック
  await page.getByTestId('md-new').click();

  // PUT が呼ばれた
  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  // PUT URL
  expect(putCalls[0]?.url).toContain('/api/smart-folders');

  // detail-title が表示される (新規アイテムの名前)
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
});

// ============================================================
// [AC-Sa100c6-2-1] 削除
// ============================================================

test('[AC-Sa100c6-2-1] 削除ボタンクリックで PUT /api/smart-folders が呼ばれる', async ({ page }) => {
  const { putCalls } = await boot(page);
  await openSFTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="recent-sf"]').click();

  // confirm をオート承認
  page.on('dialog', (dialog) => void dialog.accept());

  await page.getByTestId('md-delete').click();

  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  // PUT body に recent-sf が含まれないこと
  const body = putCalls[0]?.body as { items: Array<{ id: string }> };
  expect(body.items.every((i) => i.id !== 'recent-sf')).toBe(true);
});

// ============================================================
// [AC-Sa100c6-2-2] 並べ替えで PUT /api/smart-folders が呼ばれる
// ============================================================

test('[AC-Sa100c6-2-2] ドラッグ並べ替えで PUT /api/smart-folders が呼ばれる', async ({ page }) => {
  const { putCalls } = await boot(page);
  await openSFTab(page);

  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(3);

  // ドラッグ操作: journal-sf を recent-sf の後ろへ
  const item0 = page.locator('[data-testid="md-item"]').nth(0);
  const item1 = page.locator('[data-testid="md-item"]').nth(1);

  const box0 = await item0.boundingBox();
  const box1 = await item1.boundingBox();

  if (box0 !== null && box1 !== null) {
    await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
    await page.mouse.down();
    await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2, { steps: 5 });
    await page.mouse.up();
  }

  // PUT が呼ばれた
  await expect(async () => {
    expect(putCalls.some((c) => c.url.includes('/api/smart-folders'))).toBe(true);
  }).toPass({ timeout: 5000 });
});

// ============================================================
// [AC-Sa100c6-2-2] read-only モードで書込 UI が disabled
// ============================================================

test('[AC-Sa100c6-2-2] read-only モードでは保存/新規/削除ボタンが disabled', async ({ page }) => {
  await boot(page, { mode: 'read-only' });
  await openSFTab(page);

  await expect(page.getByTestId('md-detail-footer')).toBeVisible({ timeout: 5000 });

  await expect(page.getByTestId('md-new')).toBeDisabled();
  await expect(page.getByTestId('md-save')).toBeDisabled();
  await expect(page.getByTestId('md-delete')).toBeDisabled();
});

test('[AC-Sa100c6-2-2] read-only モードでは SmartFolderForm のフィールドが disabled', async ({ page }) => {
  await boot(page, { mode: 'read-only' });
  await openSFTab(page);

  await expect(page.getByTestId('sf-form')).toBeVisible({ timeout: 5000 });

  // 名前フィールドが disabled
  await expect(page.getByTestId('sf-form-name')).toBeDisabled();

  // 種別ボタンが disabled
  await expect(page.getByTestId('sf-form-kind-query')).toBeDisabled();
  await expect(page.getByTestId('sf-form-kind-pin')).toBeDisabled();

  // DQL テキストエリアが disabled
  await expect(page.getByTestId('sf-form-dql')).toBeDisabled();
});

// ============================================================
// [AC-Sa100c6-2-1] pin 種別のアイテムも表示できる
// ============================================================

test('[AC-Sa100c6-2-1] pin 種別のアイテムを選択すると sf-form-kind-pin が active になる', async ({ page }) => {
  await boot(page);
  await openSFTab(page);

  await page.locator('[data-testid="md-item"][data-id="notes-pin"]').click();

  await expect(page.getByTestId('sf-form-kind-pin')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sf-form-path')).toBeVisible();
});

// ============================================================
// [COMPAT] 既存テンプレートタブが壊れていない
// ============================================================

test('[COMPAT] テンプレートタブが引き続き表示される', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="templates"]').click();

  await expect(page.locator('[data-testid="md-panel"][data-group="templates"]')).toBeVisible();
});
