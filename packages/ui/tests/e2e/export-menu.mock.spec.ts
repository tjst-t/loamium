/**
 * Story Sa8ee62-2 ⋯ アクションメニュー PDF エクスポート mock テスト。
 * page.route で /api/* をモックし、ブラウザ内 UI の振る舞いを検証する。
 * 実サーバー / vault は使わない。
 *
 * [AC-Sa8ee62-2-1] ⋯ メニューに PDF エクスポート / Copy link / Copy path が存在する
 * [AC-Sa8ee62-2-2] PDF エクスポートが export API を呼びブラウザダウンロードを起動する
 * [AC-Sa8ee62-2-3] メニュー開閉 / API エラー時に UI クラッシュしない
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-10';
const JOURNAL_PATH = `journals/${DATE}.md`;

/** ジャーナルレスポンス (メニューテスト用の任意ノートとして使う) */
function journal(content = 'export-test 本文テスト。\n'): Record<string, unknown> {
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

/**
 * アプリを起動し、ジャーナルが開かれた状態にする共通ヘルパー。
 * ActionsMenu のテストはどのノートでも可 — ジャーナルを使う。
 */
async function openApp(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal()));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('export-test 本文テスト');
  return unexpected;
}

// ---- [AC-Sa8ee62-2-1] メニュー項目の存在確認 ----

test('[AC-Sa8ee62-2-1] ⋯ メニューに PDF エクスポート / Copy link / Copy path の 3 項目がある', async ({
  page,
}) => {
  const unexpected = await openApp(page);

  // メニューを開く
  await page.getByTestId('info-actions-btn').click();
  await expect(page.getByTestId('info-actions-menu')).toHaveClass(/open/);

  // 3 項目が存在する
  await expect(page.getByTestId('action-export-pdf')).toBeVisible();
  await expect(page.getByTestId('action-copy-link')).toBeVisible();
  await expect(page.getByTestId('action-copy-path')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sa8ee62-2-1] ⋯ メニューは開閉できる (ボタンクリック → scrim クリックで閉じる)', async ({
  page,
}) => {
  const unexpected = await openApp(page);

  const menu = page.getByTestId('info-actions-menu');
  // 初期は閉じている
  await expect(menu).not.toHaveClass(/open/);

  // ボタンで開く
  await page.getByTestId('info-actions-btn').click();
  await expect(menu).toHaveClass(/open/);
  await expect(page.getByTestId('info-actions-btn')).toHaveAttribute('aria-expanded', 'true');

  // scrim をクリックで閉じる
  await page.locator('.info-actions-scrim').click();
  await expect(menu).not.toHaveClass(/open/);
  await expect(page.getByTestId('info-actions-btn')).toHaveAttribute('aria-expanded', 'false');

  expect(unexpected).toEqual([]);
});

// ---- [AC-Sa8ee62-2-2] PDF エクスポート: export API 呼び出し + ブラウザダウンロード ----

test('[AC-Sa8ee62-2-2] PDF エクスポートボタンが export API を呼びダウンロードを起動する', async ({
  page,
}) => {
  const unexpected = await openApp(page);

  // PDF バイト列のダミー (最小 PDF ヘッダ)
  const pdfBytes = Buffer.from('%PDF-1.4 fake-pdf-content-for-test');
  let exportCalled = false;
  let exportUrl = '';

  // export エンドポイントをモック (glob で journals/** を含むパスにマッチ)
  await page.route('**/api/notes/**/export*', (route) => {
    exportCalled = true;
    exportUrl = route.request().url();
    void route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${DATE}.pdf"`,
      },
      body: pdfBytes,
    });
  });

  // ダウンロードイベントを待機してからボタンをクリック
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByTestId('info-actions-btn').click();
      await expect(page.getByTestId('action-export-pdf')).toBeVisible();
      await page.getByTestId('action-export-pdf').click();
    })(),
  ]);

  // export API が呼ばれた
  expect(exportCalled).toBe(true);
  expect(exportUrl).toContain('/export');
  expect(exportUrl).toContain('format=pdf');

  // ダウンロードファイル名が .pdf で終わる
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  expect(unexpected).toEqual([]);
});

test('[AC-Sa8ee62-2-2] Copy link がクリップボードに [[タイトル]] を書き込む', async ({
  page,
}) => {
  const unexpected = await openApp(page);

  // クリップボードへのアクセスを許可
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.getByTestId('info-actions-btn').click();
  await page.getByTestId('action-copy-link').click();

  // メニューが閉じる
  await expect(page.getByTestId('info-actions-menu')).not.toHaveClass(/open/);

  // クリップボードの内容を確認 (journals/2026-07-10.md の title = "2026-07-10")
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(`[[${DATE}]]`);

  expect(unexpected).toEqual([]);
});

test('[AC-Sa8ee62-2-2] Copy path がクリップボードにパスを書き込む', async ({ page }) => {
  const unexpected = await openApp(page);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.getByTestId('info-actions-btn').click();
  await page.getByTestId('action-copy-path').click();

  await expect(page.getByTestId('info-actions-menu')).not.toHaveClass(/open/);

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(JOURNAL_PATH);

  expect(unexpected).toEqual([]);
});

// ---- [AC-Sa8ee62-2-3] エラーハンドリング — UI クラッシュしない ----

test('[AC-Sa8ee62-2-3] export API エラー (500) は UI をクラッシュさせない', async ({ page }) => {
  const unexpected = await openApp(page);

  // export エンドポイントを 500 で応答
  await page.route('**/api/notes/**/export*', (route) => {
    void route.fulfill(json({ error: 'internal', message: 'boom' }, 500));
  });

  // ページエラー (uncaught exception) をキャプチャ
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  await page.getByTestId('info-actions-btn').click();
  await page.getByTestId('action-export-pdf').click();

  // 少し待ってエラーが収束するのを確認
  await page.waitForTimeout(500);

  // UI がまだ機能していることを確認 (エディタが表示されている)
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('export-test 本文テスト');

  // ページがクラッシュ (uncaught exception) していない
  expect(pageErrors).toHaveLength(0);

  expect(unexpected).toEqual([]);
});

test('[AC-Sa8ee62-2-3] ノート未オープン時は PDF エクスポートボタンが disabled', async ({
  page,
}) => {
  // notePath = null になる状態は info-panel の "ノート未オープン" 表示のとき。
  // ジャーナルが開いている通常状態では notePath が存在するので disabled=false になる。
  // ここでは installCatchAll のみで notes: [] を返し、ジャーナルなし状態を作る。
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  // ジャーナルなし状態 (journal の route を登録しない → journal は open されず notePath=null に)
  await page.route('**/api/journal', (route) => {
    // nullコンテンツのジャーナルでもパスがあるのでnoPathシナリオは作りにくい
    // ここでは 404 相当の応答でジャーナルが開けない状態を作る
    void route.fulfill(json({ error: 'not_found', message: 'no journal' }, 404));
  });

  await page.goto(readHarnessState().uiUrl);

  // ジャーナルが開けないのでエディタは空/ノート未オープン状態
  // その場合 info-actions-btn はあるが action-export-pdf は disabled
  const exportBtn = page.getByTestId('action-export-pdf');

  // メニューを開いて確認
  await page.getByTestId('info-actions-btn').click();
  await expect(exportBtn).toBeVisible();
  await expect(exportBtn).toBeDisabled();

  expect(unexpected).toEqual([]);
});
