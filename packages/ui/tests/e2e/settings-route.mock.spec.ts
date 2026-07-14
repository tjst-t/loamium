/**
 * 設定ページのルート化 + 下部バー + defaultFolder 再取得 mock テスト
 * (Sa10026-9 #2 / #3 / #7)。
 *
 * #2: 設定はオーバーレイではなく /settings ルート。歯車で遷移し履歴に積む。戻るでエディタへ。
 * #3: サイドバー最下部バーは左=歯車(設定) / 右=フォルダ(すべてのファイル) の 2 分割。
 *     旧サイドバー上部の歯車は撤去。
 * #7: 設定画面で defaultFolder を保存すると App が再取得し、同一セッションの
 *     新規ノートモーダルに即 prefill される (リロード不要)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY_JOURNAL = {
  date: '2026-07-14',
  path: 'journals/2026-07-14.md',
  content: '',
  frontmatter: null,
  body: '',
  created: false,
  mtime: 1000,
};

async function boot(page: Page): Promise<{ unexpected: string[]; savedDefaultFolder: () => string }> {
  const unexpected = await installCatchAll(page);
  // settings/system は GET で現在値、PUT で保存値を反映する (再取得で新値が返る)
  let currentDefaultFolder = '';
  await page.route('**/api/settings/system', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(
        json({
          settings: {
            theme: 'system',
            defaultFolder: currentDefaultFolder,
            journalTemplate: 'system/templates/journal.md',
            showSystemFolder: false,
          },
        }),
      );
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON() as { settings: { defaultFolder: string } };
      currentDefaultFolder = body.settings.defaultFolder;
      void route.fulfill(json({ settings: body.settings }));
    } else {
      void route.fallback();
    }
  });
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ folders: [] }));
  });
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: [] }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  return { unexpected, savedDefaultFolder: () => currentDefaultFolder };
}

// ===========================================================================
// [#3] 下部バーの 2 分割 (左=歯車 / 右=フォルダ)。上部の歯車は撤去。
// ===========================================================================

test('[#3] 下部バーに歯車(設定)とフォルダ(ファイル)ボタンがあり、上部歯車は撤去', async ({ page }) => {
  await boot(page);
  const bar = page.getByTestId('sidebar-bottom-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('sidebar-settings')).toBeVisible();
  await expect(bar.getByTestId('sidebar-show-all')).toBeVisible();
  // 上部ヘッダーには歯車が無い (sidebar-settings は下部バーの 1 個のみ)
  await expect(page.getByTestId('sidebar-settings')).toHaveCount(1);
});

// ===========================================================================
// [#2] 歯車で /settings に遷移 → 戻るでエディタに戻る (ルート化・履歴に積む)
// ===========================================================================

test('[#2] 歯車で /settings に遷移し、戻るでエディタへ戻る', async ({ page }) => {
  await boot(page);
  // 遷移前はエディタ
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('settings-view')).toHaveCount(0);

  // 歯車クリック → 設定ページ (route)
  await page.getByTestId('sidebar-bottom-bar').getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  // route-display が /settings を示す
  await expect(page.getByTestId('route-display')).toContainText('/settings');
  // エディタは非表示
  await expect(page.getByTestId('editor')).not.toBeVisible();

  // ブラウザの戻るでエディタへ戻る (履歴に積まれている)
  await page.goBack();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('settings-view')).toHaveCount(0);
});

// ===========================================================================
// [#3] フォルダボタンで /files に遷移する
// ===========================================================================

test('[#3] 下部バーのフォルダボタンで /files (すべてのファイル) に遷移する', async ({ page }) => {
  await boot(page);
  await page.getByTestId('sidebar-bottom-bar').getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId('files-list')).toBeVisible();
});

// ===========================================================================
// [#7] 設定で defaultFolder を保存すると、新規ノートモーダルに即 prefill される
// ===========================================================================

test('[#7] 設定保存後、新規ノートの既定フォルダが同一セッションで反映される', async ({ page }) => {
  await boot(page);

  // 設定ページへ
  await page.getByTestId('sidebar-bottom-bar').getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // defaultFolder を入力して保存
  await page.locator('[data-testid="settings-field"][data-name="defaultFolder"]').fill('notes');
  await page.locator('[data-testid="settings-save"][data-group="general"]').click();
  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'saved');

  // エディタへ戻る
  await page.goBack();
  await expect(page.getByTestId('editor')).toBeVisible();

  // 新規ノートモーダルを開く → defaultFolder が prefill されている (リロード不要)
  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
  await expect(page.getByTestId('new-note-path')).toHaveValue('notes/');
});
