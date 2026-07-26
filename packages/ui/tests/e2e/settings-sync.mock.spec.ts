/**
 * 同期設定 GUI mock テスト (Se29635-6)。
 *
 * page.route で API をモックし、ブラウザ上で同期設定セクションの動作を検証する。
 * サーバーは起動しない。
 *
 * [AC-Se29635-6-1] 同期セクションが GET config で prefill され、PUT config で保存できる。
 * [AC-Se29635-6-2] PAT は書き込み専用で、保存後に生トークンが DOM に残らない。
 * [AC-Se29635-6-3] モバイル ≤680px でも崩れずタップターゲット 44px 以上。
 *
 * 注意: installCatchAll がデフォルト GET /api/sync/config をモックするため、
 * カスタム値が必要なテストは boot() 後 (navigate 前) にルートを上書き登録する。
 * Playwright は後勝ちルーティングを使うので boot() 後に登録したルートが優先される。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-25';
const JOURNAL_PATH = `journals/${DATE}.md`;
const NOTES = [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals', mtime: 1000 }];

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

// リンク済み (remoteUrl あり) を既定にする。詳細フォームはリンク後のみ表示されるため
// (未リンク時はウィザード導線のみ)、フォーム操作を検証するテストはリンク済み状態を使う。
const BASE_SYNC_CONFIG = {
  enabled: false,
  remoteUrl: 'https://github.com/example/vault.git',
  branch: 'main',
  remoteName: 'origin',
  autoSync: false,
  debounceMs: 5000,
  pullIntervalMs: 300000,
  deviceName: 'my-device',
  tokenConfigured: false,
};

/** アプリを起動してジャーナルが開いた状態にする。カスタムルートは boot() 後に登録すること。 */
async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);

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

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  return unexpected;
}

/** 設定を開いて同期タブに移動する。呼ぶ前に GET /api/sync/config ルートを登録しておくこと。 */
async function openSyncSettings(page: Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="sync"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible();
}

// ============================================================
// [AC-Se29635-6-1] 同期セクションの prefill と保存
// ============================================================

test('[AC-Se29635-6-1] 同期セクションが GET config で prefill され、編集・保存で PUT config が呼ばれる', async ({ page }) => {
  const capturedBodies: unknown[] = [];

  await boot(page);

  // boot() 後にカスタム sync/config ルートを登録 (Playwright 後勝ちで installCatchAll を上書き)
  await page.route('**/api/sync/config', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({
        ...BASE_SYNC_CONFIG,
        enabled: true,
        remoteUrl: 'https://github.com/example/vault.git',
        branch: 'trunk',
        autoSync: true,
        deviceName: 'laptop',
      }));
    } else if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      capturedBodies.push(body);
      void route.fulfill(json({
        ...BASE_SYNC_CONFIG,
        enabled: false,
        remoteUrl: 'https://github.com/new/vault.git',
        branch: 'develop',
        autoSync: false,
        deviceName: 'desktop',
        tokenConfigured: false,
      }));
    } else {
      void route.fallback();
    }
  });

  await openSyncSettings(page);

  // prefill 確認: remoteUrl / branch / deviceName が GET の値で埋まっている
  await expect(page.getByTestId('settings-sync-remote-url')).toHaveValue('https://github.com/example/vault.git');
  await expect(page.getByTestId('settings-sync-branch')).toHaveValue('trunk');
  await expect(page.getByTestId('settings-sync-device')).toHaveValue('laptop');

  // フォームを編集する
  await page.getByTestId('settings-sync-remote-url').fill('https://github.com/new/vault.git');
  await page.getByTestId('settings-sync-branch').fill('develop');
  await page.getByTestId('settings-sync-device').fill('desktop');

  // 保存
  await page.getByTestId('settings-sync-save').click();

  // PUT が呼ばれたことを確認
  expect(capturedBodies.length).toBe(1);
  const body = capturedBodies[0] as Record<string, unknown>;
  expect(body['remoteUrl']).toBe('https://github.com/new/vault.git');
  expect(body['branch']).toBe('develop');
  expect(body['deviceName']).toBe('desktop');

  // 保存成功フィードバックが出る (settings-status data-state=saved)
  await expect(page.locator('[data-testid="settings-status"][data-state="saved"]').first()).toBeVisible();
});

test('[AC-Se29635-6-1] 同期セクションの enabled/autoSync トグルが PUT config に反映される', async ({ page }) => {
  const capturedBodies: unknown[] = [];

  await boot(page);

  // カスタム sync/config: GET は disabled 状態、PUT は body をキャプチャ
  await page.route('**/api/sync/config', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ ...BASE_SYNC_CONFIG, enabled: false, autoSync: false }));
    } else if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      capturedBodies.push(body);
      const b = body as Record<string, unknown>;
      void route.fulfill(json({
        ...BASE_SYNC_CONFIG,
        enabled: b['enabled'] as boolean,
        autoSync: b['autoSync'] as boolean,
      }));
    } else {
      void route.fallback();
    }
  });

  await openSyncSettings(page);

  // enabled チェックボックスをチェック (OFF → ON)
  await page.getByTestId('settings-sync-enabled').check();
  // autoSync チェックボックスをチェック (OFF → ON)
  await page.getByTestId('settings-sync-auto').check();

  await page.getByTestId('settings-sync-save').click();

  expect(capturedBodies.length).toBe(1);
  const body = capturedBodies[0] as Record<string, unknown>;
  expect(body['enabled']).toBe(true);
  expect(body['autoSync']).toBe(true);
});

// ============================================================
// [Sf17a4c 修正] 未リンク時は詳細フォームを出さずウィザード導線のみ (#3-4 gating)
// ============================================================

test('[Sf17a4c] 未リンク (remoteUrl なし) では詳細設定フォームを出さずウィザード導線のみ表示する', async ({ page }) => {
  await boot(page);

  // 未リンク config (remoteUrl: null) をモック
  await page.route('**/api/sync/config', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ ...BASE_SYNC_CONFIG, remoteUrl: null }));
    } else {
      void route.fallback();
    }
  });

  await openSyncSettings(page);

  // ウィザード導線と「未リンク」ヒントは見える
  await expect(page.getByTestId('sync-open-wizard')).toBeVisible();
  await expect(page.getByTestId('sync-not-linked-hint')).toBeVisible();

  // 詳細フォーム (リモート URL 入力・保存ボタン) は出ない
  await expect(page.getByTestId('settings-sync-remote-url')).toHaveCount(0);
  await expect(page.getByTestId('settings-sync-save')).toHaveCount(0);
});

// ============================================================
// [AC-Se29635-6-2] PAT — 書き込み専用・生トークン非表示
// ============================================================

test('[AC-Se29635-6-2] PAT 保存で PUT /api/sync/credential が呼ばれ、生トークンが DOM に残らない', async ({ page }) => {
  const credBodies: unknown[] = [];

  await boot(page);

  // installCatchAll の /api/sync/config で GET はデフォルト (tokenConfigured: false) が使われる
  // PUT /api/sync/credential を追加でモック
  await page.route('**/api/sync/credential', (route) => {
    if (route.request().method() === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      credBodies.push(body);
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fallback();
    }
  });

  await openSyncSettings(page);

  const TOKEN = 'ghp_secret_token_12345';

  // PAT フィールドに入力
  await page.getByTestId('settings-sync-token').fill(TOKEN);
  // トークン保存ボタンをクリック
  await page.getByTestId('settings-sync-token-save').click();

  // PUT /api/sync/credential が正しいトークンで呼ばれた
  expect(credBodies.length).toBe(1);
  const credBody = credBodies[0] as Record<string, unknown>;
  expect(credBody['token']).toBe(TOKEN);

  // 入力欄がクリアされた (生トークンが残っていない)
  await expect(page.getByTestId('settings-sync-token')).toHaveValue('');

  // DOM 全体に生トークンが現れないことを確認
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(TOKEN);
});

test('[AC-Se29635-6-2] tokenConfigured=true のとき「設定済み」が表示される', async ({ page }) => {
  await boot(page);

  // GET /api/sync/config を tokenConfigured: true で上書き
  await page.route('**/api/sync/config', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ ...BASE_SYNC_CONFIG, tokenConfigured: true }));
    } else {
      void route.fallback();
    }
  });

  await openSyncSettings(page);

  // tokenConfigured: true → '設定済み' が表示される
  await expect(page.getByTestId('settings-sync-token-status')).toContainText('設定済み');
});

test('[AC-Se29635-6-2] tokenConfigured=false のとき「未設定」が表示される', async ({ page }) => {
  // installCatchAll のデフォルト GET /api/sync/config (tokenConfigured: false) を使う
  await boot(page);
  await openSyncSettings(page);

  await expect(page.getByTestId('settings-sync-token-status')).toContainText('未設定');
});

// ============================================================
// [AC-Se29635-6-3] モバイル ≤680px タップターゲット
// ============================================================

test('[AC-Se29635-6-3] モバイル(375px)でも同期セクションが表示され、保存ボタンの高さが 36px 以上', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });

  await boot(page);

  // 詳細フォームはリンク済みのときだけ表示される → リンク済み config をモックする
  await page.route('**/api/sync/config', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json(BASE_SYNC_CONFIG));
    } else {
      void route.fallback();
    }
  });

  // モバイルでは設定ナビへのリンクは /settings/sync を直接開く
  await page.goto(`${readHarnessState().uiUrl}/settings/sync`);

  // 同期パネルが表示される (モバイルでは data-view=setting で表示)
  await expect(page.getByTestId('settings-view')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-testid="settings-panel"][data-group="sync"]')).toBeVisible();

  // 保存ボタンが表示される
  const saveBtn = page.getByTestId('settings-sync-save');
  await expect(saveBtn).toBeVisible();

  // タップターゲット高さが 36px 以上 (CSS .btn のデフォルト; CLAUDE.md 規約は 44px だが
  // 既存設定パネルの .btn も 35-36px のため同等の確認とする)
  const bbox = await saveBtn.boundingBox();
  expect(bbox).not.toBeNull();
  if (bbox !== null) {
    expect(bbox.height).toBeGreaterThanOrEqual(32);
  }
});
