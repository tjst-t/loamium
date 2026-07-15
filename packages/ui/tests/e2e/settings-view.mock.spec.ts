/**
 * 統一設定画面 mock テスト (Sa10026-7)。
 *
 * page.route で API をモックし、ブラウザ上で UI の動作を検証する。
 * サーバーは起動しない。
 *
 * [AC-Sa10026-7-1] 統一設定画面が左ナビを持ち、各群を型付き API 経由で編集・保存できる。
 * [AC-Sa10026-7-2] テンプレ/SF/コマンドは導線リンク (per-item 管理はここに再実装しない)。
 * [AC-Sa10026-7-3] apiKey は $ENV_VAR 参照として表示。read-only/append-only では書込 UI 無効化。
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

/** 共通ブートストラップ: app を起動してジャーナルが開いた状態にする */
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

// ============================================================
// [AC-Sa10026-7-1] 設定画面の開閉とナビ
// ============================================================

test('[AC-Sa10026-7-1] sidebar-settings クリックで設定画面が開く', async ({ page }) => {
  await boot(page);

  // 設定ボタンをクリック
  await page.getByTestId('sidebar-settings').click();

  // settings-view が表示される
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // 左ナビに 3 群が存在する
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="general"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="agent"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="privacy"]')).toBeVisible();

  // 全体タブが初期アクティブ
  await expect(page.locator('[data-testid="settings-panel"][data-group="general"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).not.toBeVisible();
  await expect(page.locator('[data-testid="settings-panel"][data-group="privacy"]')).not.toBeVisible();
});

test('[AC-Sa10026-7-1] エージェントタブへの切替', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // エージェントタブをクリック
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  // エージェントパネルが表示される
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-panel"][data-group="general"]')).not.toBeVisible();
});

test('[AC-Sa10026-7-1] プライバシータブへの切替', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();

  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="privacy"]')).toBeVisible();
});

// ============================================================
// [AC-Sa10026-7-1] 全体設定の保存
// ============================================================

test('[AC-Sa10026-7-1] 全体設定を変更して保存すると PUT /api/settings/system が呼ばれる', async ({ page }) => {
  const putCalls: Array<Record<string, unknown>> = [];

  // PUT を記録するルートを上書き
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
  await page.route('**/api/settings/system', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ settings: { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false } }));
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      putCalls.push(body);
      void route.fulfill(json({ settings: (body as { settings: Record<string, unknown> }).settings }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // defaultFolder を 'notes' に変更
  await page.locator('[data-testid="settings-field"][data-name="defaultFolder"]').fill('notes');

  // 保存ボタンをクリック
  await page.locator('[data-testid="settings-save"][data-group="general"]').click();

  // PUT が呼ばれた
  await page.waitForFunction(() => true); // tick
  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 3000 });

  const body = putCalls[0] as { settings: { defaultFolder: string } };
  expect(body.settings.defaultFolder).toBe('notes');

  // settings-status が saved になる
  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'saved');

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa10026-7-3] apiKey は $ENV_VAR 参照として表示
// ============================================================

test('[AC-Sa10026-7-3] エージェントタブで $ENV_VAR 参照のキーはプレースホルダで表示され $ENV 参照バッジが出る', async ({ page }) => {
  // 接続情報が設定済みの mock ($ENV_VAR 形式)
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
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({
        connection: {
          api: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          apiKeyRef: '$ANTHROPIC_API_KEY',
          hasApiKey: true,
        },
      }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();

  // apiKeyEnv フィールド: $ENV_VAR の場合は value が空でプレースホルダで参照名を表示
  const apiKeyField = page.locator('[data-testid="settings-field"][data-name="apiKeyEnv"]');
  await expect(apiKeyField).toBeVisible();
  // 未変更状態では値は空 (プレースホルダで表示)
  await expect(apiKeyField).toHaveValue('');
  // プレースホルダに $ENV_VAR 名が出ている
  await expect(apiKeyField).toHaveAttribute('placeholder', '$ANTHROPIC_API_KEY');
  // $ENV 参照バッジが visible (apiKeyDirty=false かつ $ENV_VAR 形式のとき表示)
  await expect(page.locator('.env-badge')).toBeVisible();

  // baseUrl も表示
  await expect(page.locator('[data-testid="settings-field"][data-name="baseUrl"]')).toHaveValue('https://api.anthropic.com');

  // model も表示
  await expect(page.locator('[data-testid="settings-field"][data-name="model"]')).toHaveValue('claude-sonnet-4-6');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-7-3] 直値キーが保存済みの場合は「保存済み」プレースホルダを表示する', async ({ page }) => {
  // 接続情報が設定済みの mock (リテラルキー — apiKeyRef が "(set)")
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
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({
        connection: {
          api: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          apiKeyRef: '(set)',
          hasApiKey: true,
        },
      }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();

  // apiKeyEnv フィールド: リテラルキーの場合は「保存済み」プレースホルダ
  const apiKeyField = page.locator('[data-testid="settings-field"][data-name="apiKeyEnv"]');
  await expect(apiKeyField).toBeVisible();
  await expect(apiKeyField).toHaveValue('');
  await expect(apiKeyField).toHaveAttribute('placeholder', '保存済み');
  // $ENV 参照バッジは非表示 (リテラルキーなので不要)
  await expect(page.locator('.env-badge')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa10026-7-1] 接続テスト成功
// ============================================================

test('[AC-Sa10026-7-1] 接続テストボタンで成功メッセージが表示される', async ({ page }) => {
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
  await page.route('**/api/settings/agent/connection/test', (route) => {
    // 新スキーマ: models 配列 + latencyMs (model は廃止)
    void route.fulfill(json({ ok: true, models: ['claude-sonnet-4-6', 'claude-opus-4-8'], latencyMs: 210 }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  // 接続テストボタンをクリック
  await page.getByTestId('settings-conn-test').click();

  // 結果が ok 状態になる
  await expect(page.getByTestId('settings-conn-result')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('settings-conn-result')).toContainText('接続成功');

  expect(unexpected).toEqual([]);
});

test('[MOCK] 接続テスト成功後にモデル一覧がドロップダウンに populate される', async ({ page }) => {
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
  await page.route('**/api/settings/agent/connection/test', (route) => {
    void route.fulfill(json({ ok: true, models: ['model-alpha', 'model-beta', 'model-gamma'], latencyMs: 100 }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  // 接続テスト実行
  await page.getByTestId('settings-conn-test').click();

  // テスト成功 → モデルがドロップダウンに反映されてコンボボックスが開く
  await expect(page.getByTestId('settings-conn-result')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('settings-model-combobox')).toHaveClass(/open/);
  const options = page.getByTestId('settings-model-options');
  await expect(options).toBeVisible();
  await expect(options.locator('li')).toHaveCount(3);

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa10026-7-1] 接続テスト失敗
// ============================================================

test('[AC-Sa10026-7-1] 接続テスト失敗時はエラーメッセージが表示される', async ({ page }) => {
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
  await page.route('**/api/settings/agent/connection/test', (route) => {
    void route.fulfill(json({ ok: false, error: '401 unauthorized' }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  await page.getByTestId('settings-conn-test').click();

  // エラー状態になる
  await expect(page.getByTestId('settings-conn-result')).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('settings-conn-result')).toContainText('401 unauthorized');

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa10026-7-1] モデル一覧取得 + 直接入力
// ============================================================

test('[AC-Sa10026-7-1] 一覧取得でモデル候補が settings-model-options に反映される', async ({ page }) => {
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
  await page.route('**/api/settings/agent/models', (route) => {
    void route.fulfill(json({ models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], source: 'api' }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  // 一覧取得ボタンをクリック
  await page.getByTestId('settings-model-refresh').click();

  // コンボボックスが開いて候補が表示される
  await expect(page.getByTestId('settings-model-combobox')).toHaveClass(/open/);
  const options = page.getByTestId('settings-model-options');
  await expect(options).toBeVisible();
  await expect(options.locator('li')).toHaveCount(3);

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-7-1] モデルコンボボックスで直接入力できる', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  // モデル入力欄に直接入力
  const modelField = page.locator('[data-testid="settings-field"][data-name="model"]');
  await modelField.fill('custom-model-id-not-in-list');
  await expect(modelField).toHaveValue('custom-model-id-not-in-list');
});

test('[AC-Sa10026-7-1] settings-model-toggle でコンボボックスが開閉する', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  const combobox = page.getByTestId('settings-model-combobox');
  const toggle = page.getByTestId('settings-model-toggle');

  // 初期状態は閉じている
  await expect(combobox).not.toHaveClass(/open/);

  // トグルクリックで開く
  await toggle.click();
  await expect(combobox).toHaveClass(/open/);

  // 再クリックで閉じる
  await toggle.click();
  await expect(combobox).not.toHaveClass(/open/);
});

// ============================================================
// [AC-Sa10026-7-1] プライバシー deny-list 追加・削除
// ============================================================

test('[AC-Sa10026-7-1] deny-list エントリを追加できる', async ({ page }) => {
  const putCalls: Array<{ deny: string[] }> = [];

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
  await page.route('**/api/settings/agent/privacy', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ deny: ['private/**'] }));
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON() as { deny: string[] };
      putCalls.push(body);
      // 実サーバーに合わせ、保存後の deny-list をそのまま返す ({ deny })。
      void route.fulfill(json({ deny: body.deny }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();

  // 既存エントリが表示される
  await expect(page.locator('[data-testid="deny-entry"][data-value="private/**"]')).toBeVisible();

  // 新しいエントリを追加
  await page.getByTestId('deny-add-input').fill('secrets/**');
  await page.getByTestId('deny-add').click();

  // UI に追加される
  await expect(page.locator('[data-testid="deny-entry"][data-value="secrets/**"]')).toBeVisible();

  // 保存
  await page.locator('[data-testid="settings-save"][data-group="privacy"]').click();

  // PUT が呼ばれた
  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 3000 });
  const firstCall = putCalls[0];
  expect(firstCall).toBeDefined();
  expect(firstCall?.deny).toContain('secrets/**');
  expect(firstCall?.deny).toContain('private/**');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-7-1] deny-list エントリを削除できる', async ({ page }) => {
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
  await page.route('**/api/settings/agent/privacy', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ deny: ['private/**', 'secrets/**'] }));
    } else {
      // 実サーバーに合わせ、保存後の deny-list をそのまま返す ({ deny })。
      const body = route.request().postDataJSON() as { deny: string[] };
      void route.fulfill(json({ deny: body.deny }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="privacy"]').click();

  // 2 件表示
  await expect(page.locator('[data-testid="deny-entry"]')).toHaveCount(2);

  // 1 件削除
  await page.locator('[data-testid="deny-entry"][data-value="secrets/**"] [data-testid="deny-del"]').click();

  // 1 件になる
  await expect(page.locator('[data-testid="deny-entry"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="deny-entry"][data-value="private/**"]')).toBeVisible();
  await expect(page.locator('[data-testid="deny-entry"][data-value="secrets/**"]')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-Sa10026-7-3] read-only モードで書込 UI が無効化される
// ============================================================

test('[AC-Sa10026-7-3] LOAMIUM_MODE=read-only では保存ボタンが disabled になる', async ({ page }) => {
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
  // read-only モードを返す health
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'read-only', agent: { enabled: false, reason: 'not_configured' } }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();

  // mode-banner が表示される
  await expect(page.getByTestId('mode-banner')).toBeVisible();
  await expect(page.getByTestId('mode-banner')).toContainText('read-only モード');

  // 全体タブの保存ボタンが disabled
  await expect(page.locator('[data-testid="settings-save"][data-group="general"]')).toBeDisabled();

  // 入力フィールドも disabled
  await expect(page.locator('[data-testid="settings-field"][data-name="defaultFolder"]')).toBeDisabled();

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-7-3] append-only モードでも書込 UI が無効化される', async ({ page }) => {
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
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'append-only', agent: { enabled: false, reason: 'not_configured' } }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();

  await expect(page.getByTestId('mode-banner')).toBeVisible();
  await expect(page.getByTestId('mode-banner')).toContainText('append-only モード');
  await expect(page.locator('[data-testid="settings-save"][data-group="general"]')).toBeDisabled();
});

// ============================================================
// [AC-Sa10026-7-2] 導線リンクが存在する
// ============================================================

/**
 * Sa100c6-1 で per-item 導線リンク (settings-link) はコンテンツグループ nav-item に昇格。
 * settings-link は撤去され、代わりにコンテンツグループの nav-item が存在する。
 */
test('[AC-Sa10026-7-2→Sa100c6-1-1] テンプレート / SF / コマンドがコンテンツグループ nav-item として settings-nav に存在する', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();

  // 3 つのコンテンツグループ nav-item が visible (settings-link ではない)
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="templates"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-nav-item"][data-group="commands"]')).toBeVisible();

  // settings-link は存在しない (撤去済み Sa100c6-1)
  await expect(page.locator('[data-testid="settings-link"]')).toHaveCount(0);
});

// ============================================================
// Edge: エージェント設定未設定時もパネルが表示される
// ============================================================

test('[MOCK] agent.json 未設定時 (connection: null) でもエージェントパネルが表示される', async ({ page }) => {
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
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ connection: null }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });
  await page.route('**/api/settings/agent/permissions', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ permissions: null }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();

  // パネルは表示される (未設定でもクラッシュしない)
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ============================================================
// [MOCK] apiKey 未変更時は PUT に apiKey を含めない (直値上書き防止)
// ============================================================

test('[MOCK] 保存済み apiKey を変更しない場合、PUT リクエストに apiKey を含めない', async ({ page }) => {
  const putCalls: Array<Record<string, unknown>> = [];

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
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({
        connection: {
          api: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          apiKeyRef: '(set)',
          hasApiKey: true,
        },
      }));
    } else if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      putCalls.push(body);
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fallback();
    }
  });
  await page.route('**/api/settings/agent/permissions', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ permissions: null }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();

  // apiKey フィールドに何も入力せず保存 (dirty=false)
  await page.locator('[data-testid="settings-save"][data-group="agent"]').click();

  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 3000 });

  // PUT リクエストに apiKey フィールドが含まれていないことを確認
  const connCall = putCalls[0];
  expect(connCall).toBeDefined();
  expect('apiKey' in (connCall ?? {})).toBe(false);

  expect(unexpected).toEqual([]);
});

test('[MOCK] apiKey を新たに入力した場合は PUT に apiKey を含める', async ({ page }) => {
  const putCalls: Array<Record<string, unknown>> = [];

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
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({
        connection: {
          api: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
          apiKeyRef: '(set)',
          hasApiKey: true,
        },
      }));
    } else if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      putCalls.push(body);
      void route.fulfill(json({ ok: true }));
    } else {
      void route.fallback();
    }
  });
  await page.route('**/api/settings/agent/permissions', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ permissions: null }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();

  // 新しい apiKey を入力 (dirty=true になる)
  const apiKeyField = page.locator('[data-testid="settings-field"][data-name="apiKeyEnv"]');
  await apiKeyField.fill('sk-new-test-key-12345');

  // 保存
  await page.locator('[data-testid="settings-save"][data-group="agent"]').click();

  await expect(async () => {
    expect(putCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 3000 });

  // PUT リクエストに apiKey が含まれていることを確認
  const connCall = putCalls[0];
  expect(connCall).toBeDefined();
  expect((connCall as { apiKey?: string }).apiKey).toBe('sk-new-test-key-12345');

  expect(unexpected).toEqual([]);
});

// ============================================================
// Edge: save エラー時にステータスが error になる
// ============================================================

test('[MOCK] 保存 API エラー時に settings-status が error になる', async ({ page }) => {
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
  await page.route('**/api/settings/system', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ settings: { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false } }));
    } else if (route.request().method() === 'PUT') {
      void route.fulfill(json({ error: 'settings_write_error', message: 'disk full' }, 500));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-save"][data-group="general"]').click();

  await expect(page.getByTestId('settings-status')).toHaveAttribute('data-state', 'error');

  expect(unexpected).toEqual([]);
});
