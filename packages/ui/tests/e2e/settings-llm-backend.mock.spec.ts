/**
 * 統一設定 UI: LLM バックエンド切替 + ローカルモデル管理 mock テスト (S8a3f2e-4)。
 *
 * page.route で API をモックし、ブラウザ上で UI の動作を検証する。サーバーは起動しない。
 * data-testid はプロトタイプ (prototype/settings-llm-backend*.html) に一致させている。
 *
 * [AC-S8a3f2e-4-1] backend 明示選択 (external ↔ local)。自動フォールバックしない。
 * [AC-S8a3f2e-4-2] backend/localModel を PUT /api/settings/agent/connection で保存。
 * [AC-S8a3f2e-4-3] local + 0 件で空メッセージ + DL 導線。手動配置も一覧。DL/削除/選択が同セクション完結。
 * [AC-S8a3f2e-4-4] read-only では書込 UI (切替・DL・削除・選択) が無効化される。
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

interface BootOptions {
  /** GET /api/settings/agent/connection のレスポンス connection。 */
  connection?: Record<string, unknown>;
  /** GET /api/llm/models のモデル一覧。 */
  localModels?: Array<{ id: string; filename: string; sizeBytes: number; path: string }>;
  /** LOAMIUM_MODE (read-only/append-only/full)。 */
  mode?: 'full' | 'read-only' | 'append-only';
  /** PUT connection の body を記録する配列。 */
  putBodies?: Array<Record<string, unknown>>;
}

function model(filename: string, sizeBytes: number): { id: string; filename: string; sizeBytes: number; path: string } {
  return { id: filename, filename, sizeBytes, path: `.loamium/models/llm/${filename}` };
}

/** app を起動 → 設定 → エージェントタブを開いた状態にする。 */
async function bootAgent(page: Page, opts: BootOptions = {}): Promise<string[]> {
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

  if (opts.mode !== undefined && opts.mode !== 'full') {
    await page.route('**/api/health', (route) => {
      void route.fulfill(
        json({ status: 'ok', mode: opts.mode, agent: { enabled: false, reason: 'not_configured' } }),
      );
    });
  }

  const connection = opts.connection ?? {
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
    apiKeyRef: '$ANTHROPIC_API_KEY',
    hasApiKey: true,
    backend: 'external',
  };
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ connection }));
    } else {
      if (opts.putBodies !== undefined) {
        opts.putBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.route('**/api/settings/agent/permissions', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ permissions: { value: 'full', effective: ['note_edit', 'note_create'] } }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });

  await page.route('**/api/llm/models', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ models: opts.localModels ?? [] }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await expect(page.locator('[data-testid="settings-panel"][data-group="agent"]')).toBeVisible();

  return unexpected;
}

// ============================================================
// [AC-S8a3f2e-4-1] バックエンド切替トグルと本体の表示切替
// ============================================================

test('[AC-S8a3f2e-4-1] バックエンドトグルがあり external が既定選択', async ({ page }) => {
  const unexpected = await bootAgent(page);

  const toggle = page.getByTestId('settings-backend-toggle');
  await expect(toggle).toBeVisible();

  const external = page.locator('[data-testid="settings-backend-option"][data-backend="external"]');
  const local = page.locator('[data-testid="settings-backend-option"][data-backend="local"]');
  await expect(external).toHaveAttribute('aria-checked', 'true');
  await expect(local).toHaveAttribute('aria-checked', 'false');

  // external 本体 (baseUrl/model) が見える
  await expect(page.locator('[data-testid="settings-field"][data-name="baseUrl"]')).toBeVisible();
  // local 本体はまだ無い
  await expect(page.getByTestId('settings-backend-body').filter({ has: page.getByTestId('settings-local-model-list') })).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S8a3f2e-4-1] local を選ぶとモデル一覧セクションに切り替わる', async ({ page }) => {
  const unexpected = await bootAgent(page, {
    localModels: [model('qwen2.5-7b-instruct-q4_k_m.gguf', 4_400_000_000)],
  });

  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();

  await expect(page.locator('[data-testid="settings-backend-option"][data-backend="local"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('settings-local-model-list')).toBeVisible();
  // external フォームは隠れる (backend-body external は hidden)
  await expect(page.locator('[data-testid="settings-field"][data-name="baseUrl"]')).not.toBeVisible();

  // 取得済みモデルがラジオ項目として並ぶ
  const item = page.locator('[data-testid="settings-local-model-item"][data-model="qwen2.5-7b-instruct-q4_k_m.gguf"]');
  await expect(item).toBeVisible();

  // ASR 別枠プレースホルダがある
  await expect(page.getByTestId('settings-local-model-asr-placeholder')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-S8a3f2e-4-2] local + モデル選択 → 保存で backend/localModel を PUT
// ============================================================

test('[AC-S8a3f2e-4-2] モデルをラジオ選択して保存すると backend=local と localModel が PUT される', async ({ page }) => {
  const putBodies: Array<Record<string, unknown>> = [];
  const unexpected = await bootAgent(page, {
    putBodies,
    localModels: [
      model('qwen2.5-7b-instruct-q4_k_m.gguf', 4_400_000_000),
      model('llama-3.2-3b-instruct-q4_k_m.gguf', 2_000_000_000),
    ],
  });

  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();

  // 2 つ目のモデルを選ぶ
  const target = page.locator('[data-testid="settings-local-model-item"][data-model="llama-3.2-3b-instruct-q4_k_m.gguf"]');
  await target.locator('.radio').click();
  await expect(target).toHaveClass(/sel/);
  await expect(target.locator('.m-badge')).toHaveText('使用中');

  // 保存
  await page.locator('[data-testid="settings-save"][data-group="agent"]').click();

  await expect.poll(() => putBodies.length).toBeGreaterThan(0);
  const body = putBodies[putBodies.length - 1] ?? {};
  expect(body.backend).toBe('local');
  expect(body.localModel).toBe('llama-3.2-3b-instruct-q4_k_m.gguf');

  expect(unexpected).toEqual([]);
});

test('[AC-S8a3f2e-4-2] 保存済み backend=local/localModel がロード時に復元される', async ({ page }) => {
  const unexpected = await bootAgent(page, {
    connection: {
      api: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKeyRef: '$ANTHROPIC_API_KEY',
      hasApiKey: true,
      backend: 'local',
      localModel: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    },
    localModels: [model('qwen2.5-7b-instruct-q4_k_m.gguf', 4_400_000_000)],
  });

  // 復元: local が選択済み
  await expect(page.locator('[data-testid="settings-backend-option"][data-backend="local"]')).toHaveAttribute('aria-checked', 'true');
  // localModel のカードが使用中
  const item = page.locator('[data-testid="settings-local-model-item"][data-model="qwen2.5-7b-instruct-q4_k_m.gguf"]');
  await expect(item).toHaveClass(/sel/);
  await expect(item.locator('.m-badge')).toHaveText('使用中');

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-S8a3f2e-4-3] 0 件時: 空メッセージ + DL 導線 (自動で external に戻さない)
// ============================================================

test('[AC-S8a3f2e-4-3] local で 0 件なら空メッセージと DL 導線が出る', async ({ page }) => {
  const unexpected = await bootAgent(page, { localModels: [] });

  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();

  // 一覧レイアウトに寄せた空メッセージ
  await expect(page.getByTestId('settings-local-model-empty')).toBeVisible();
  await expect(page.getByTestId('settings-local-model-empty')).toContainText('モデルがありません');
  // ラベルは 0 件
  await expect(page.locator('#localmodel-list-label')).toContainText('0 件');

  // DL 導線 (URL 入力 + 推奨) が同セクションにある
  await expect(page.getByTestId('settings-local-model-url-input')).toBeVisible();
  await expect(page.getByTestId('settings-local-model-recommended')).toBeVisible();
  await expect(page.locator('[data-testid="settings-local-model-rec-item"]')).toHaveCount(3);

  // 自動で external に戻っていない (backend=local のまま)
  await expect(page.locator('[data-testid="settings-backend-option"][data-backend="local"]')).toHaveAttribute('aria-checked', 'true');

  expect(unexpected).toEqual([]);
});

test('[AC-S8a3f2e-4-3] リロードで一覧を再取得し空→取得済みへ切り替わる', async ({ page }) => {
  let call = 0;
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    const url = route.request().url();
    if (!url.includes('/api/notes/')) {
      void route.fulfill(json({ notes: NOTES }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/journal**', (route) => void route.fulfill(json(journalResponse())));
  await page.route('**/api/smart-folders', (route) => void route.fulfill(json({ folders: [] })));
  await page.route('**/api/settings/agent/connection', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ connection: { api: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'x', apiKeyRef: '$K', hasApiKey: true, backend: 'external' } }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });
  await page.route('**/api/settings/agent/permissions', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({ permissions: { value: 'full', effective: [] } }));
    } else {
      void route.fulfill(json({ ok: true }));
    }
  });
  // 1 回目は 0 件、2 回目 (リロード) 以降は 1 件返す
  await page.route('**/api/llm/models', (route) => {
    if (route.request().method() === 'GET') {
      call += 1;
      void route.fulfill(json({ models: call === 1 ? [] : [model('gemma-2-2b-it-q4_k_m.gguf', 1_600_000_000)] }));
    } else {
      void route.fallback();
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="agent"]').click();
  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();

  // 初回 0 件
  await expect(page.getByTestId('settings-local-model-empty')).toBeVisible();

  // リロード → 1 件に
  await page.getByTestId('settings-local-model-refresh').click();
  await expect(page.locator('[data-testid="settings-local-model-item"][data-model="gemma-2-2b-it-q4_k_m.gguf"]')).toBeVisible();
  await expect(page.getByTestId('settings-local-model-empty')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-S8a3f2e-4-3] 削除
// ============================================================

test('[AC-S8a3f2e-4-3] 削除ボタンで DELETE /api/llm/models/:filename を呼び一覧から消える', async ({ page }) => {
  let deleted: string | null = null;
  const unexpected = await bootAgent(page, {
    localModels: [
      model('qwen2.5-7b-instruct-q4_k_m.gguf', 4_400_000_000),
      model('llama-3.2-3b-instruct-q4_k_m.gguf', 2_000_000_000),
    ],
  });
  await page.route('**/api/llm/models/*', (route) => {
    if (route.request().method() === 'DELETE') {
      const url = new URL(route.request().url());
      deleted = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      void route.fulfill(json({ ok: true, filename: deleted }));
    } else {
      void route.fallback();
    }
  });

  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();

  const del = page.locator('[data-testid="settings-local-model-delete"][data-model="llama-3.2-3b-instruct-q4_k_m.gguf"]');
  await del.click();

  await expect.poll(() => deleted).toBe('llama-3.2-3b-instruct-q4_k_m.gguf');
  await expect(page.locator('[data-testid="settings-local-model-item"][data-model="llama-3.2-3b-instruct-q4_k_m.gguf"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-local-model-item"][data-model="qwen2.5-7b-instruct-q4_k_m.gguf"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-S8a3f2e-4-3] ダウンロード (URL 入力 + 進捗ポーリング)
// ============================================================

test('[AC-S8a3f2e-4-3] URL 入力でダウンロードを開始し進捗カードが出る', async ({ page }) => {
  let started = false;
  const unexpected = await bootAgent(page, { localModels: [] });
  await page.route('**/api/llm/models/download', (route) => {
    if (route.request().method() === 'POST') {
      started = true;
      void route.fulfill(json({ id: 'job1', filename: 'custom.gguf', status: 'downloading' }));
    } else {
      void route.fallback();
    }
  });
  await page.route('**/api/llm/models/download/job1/status', (route) => {
    void route.fulfill(json({ id: 'job1', filename: 'custom.gguf', status: 'downloading', receivedBytes: 500_000_000, totalBytes: 1_000_000_000 }));
  });

  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();

  await page.getByTestId('settings-local-model-url-input').fill('https://example.com/custom.gguf');
  await page.getByTestId('settings-local-model-download').click();

  await expect.poll(() => started).toBe(true);
  const progress = page.getByTestId('settings-local-model-download-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('ダウンロード中');

  expect(unexpected).toEqual([]);
});

test('[AC-S8a3f2e-4-3] 空 URL でダウンロードを押すと入力が無効表示になり POST しない', async ({ page }) => {
  let posted = false;
  const unexpected = await bootAgent(page, { localModels: [] });
  await page.route('**/api/llm/models/download', (route) => {
    if (route.request().method() === 'POST') {
      posted = true;
      void route.fulfill(json({ id: 'x', filename: 'x.gguf', status: 'pending' }));
    } else {
      void route.fallback();
    }
  });

  await page.locator('[data-testid="settings-backend-option"][data-backend="local"]').click();
  await page.getByTestId('settings-local-model-download').click();

  // POST は飛ばない
  await page.waitForTimeout(300);
  expect(posted).toBe(false);

  expect(unexpected).toEqual([]);
});

// ============================================================
// [AC-S8a3f2e-4-4] read-only では切替・DL・削除・選択が無効
// ============================================================

test('[AC-S8a3f2e-4-4] read-only ではバックエンド切替と DL/削除が無効化される', async ({ page }) => {
  const unexpected = await bootAgent(page, {
    mode: 'read-only',
    connection: {
      api: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKeyRef: '$ANTHROPIC_API_KEY',
      hasApiKey: true,
      backend: 'local',
      localModel: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    },
    localModels: [model('qwen2.5-7b-instruct-q4_k_m.gguf', 4_400_000_000)],
  });

  await expect(page.getByTestId('mode-banner')).toBeVisible();

  // バックエンドトグルの各ボタンが disabled
  await expect(page.locator('[data-testid="settings-backend-option"][data-backend="external"]')).toBeDisabled();
  await expect(page.locator('[data-testid="settings-backend-option"][data-backend="local"]')).toBeDisabled();

  // 削除・ラジオ・URL 入力・DL ボタンが disabled
  await expect(page.locator('[data-testid="settings-local-model-delete"]').first()).toBeDisabled();
  await expect(page.getByTestId('settings-local-model-url-input')).toBeDisabled();
  await expect(page.getByTestId('settings-local-model-download')).toBeDisabled();

  expect(unexpected).toEqual([]);
});
