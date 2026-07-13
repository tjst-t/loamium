/**
 * サイドバー「スマートコマンド」セクション mock テスト。
 *
 * AC-sidebar-cmd-1: スマートビューに切り替えると「スマートコマンド」セクションが表示される。
 * AC-sidebar-cmd-2: コマンド一覧 (valid/invalid) が正しく描画される。
 *   - valid コマンド: 通常スタイル、data-valid="true"
 *   - invalid コマンド: 無効スタイル、data-valid="false"
 * AC-sidebar-cmd-3: クリックすると onOpenNote → loadNote → isCommandFile → CommandEditor が開く。
 * AC-sidebar-cmd-4: コマンドが存在しない場合は「コマンドがありません」が表示される。
 * AC-sidebar-cmd-5: セクションヘッダをクリックすると折り畳み/展開できる。
 *
 * testid 契約:
 *   sidebar-commands-section, sidebar-commands-section-header,
 *   sidebar-commands-section-toggle, sidebar-commands-empty,
 *   sidebar-command-item (data-command-id, data-valid)
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-13';
const JOURNAL_PATH = `journals/${DATE}.md`;

// ---- フィクスチャ ----

const VALID_COMMAND: Record<string, unknown> = {
  id: 'create-todo',
  name: 'create todo',
  path: 'commands/create-todo.yaml',
  description: 'タスクを今日のジャーナルに追記',
  params: [{ name: 'summary', label: 'タスク概要', type: 'string', required: true }],
  valid: true,
};

const INVALID_COMMAND: Record<string, unknown> = {
  id: 'broken-cmd',
  name: 'broken-cmd',
  path: 'commands/broken-cmd.yaml',
  valid: false,
  error: 'steps array must have at least 1 element',
};

const VALID_COMMAND_CONTENT = [
  'name: create todo',
  'description: タスクを今日のジャーナルに追記',
  'params:',
  '  - name: summary',
  '    label: タスク概要',
  '    required: true',
  'steps:',
  '  - kind: journal-append',
  '    content: "- [ ] {{summary}}"',
].join('\n');

function journal(): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content: '# ジャーナル\n',
    frontmatter: null,
    body: '# ジャーナル\n',
    created: false,
    mtime: 1000,
  };
}

/**
 * 共通ブートストラップ:
 * - /api/notes, /api/journal, /api/smart-folders をモック
 * - /api/commands は引数で上書き可能
 */
async function boot(
  page: Page,
  commandsPayload: { commands: Record<string, unknown>[] } = { commands: [] },
): Promise<string[]> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(journal()));
  });
  await page.route('**/api/smart-folders', (route) => {
    // GET の場合のみ空リストで応答 (PUT は fallback)
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ version: 1, items: [] }));
      return;
    }
    void route.fallback();
  });
  await page.route('**/api/commands', (route) => {
    void route.fulfill(json(commandsPayload));
  });

  return unexpected;
}

// ======================================================================
// AC-sidebar-cmd-1: スマートビューに切り替えるとセクションが表示される
// ======================================================================

test('[AC-sidebar-cmd-1] スマートビューに切り替えると「スマートコマンド」セクションが表示される', async ({ page }) => {
  await boot(page);
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  await expect(page.getByTestId('sidebar-commands-section')).toBeVisible();
  await expect(page.getByTestId('sidebar-commands-section-toggle')).toBeVisible();
  await expect(page.getByTestId('sidebar-commands-section-toggle')).toContainText('スマートコマンド');
});

// ======================================================================
// AC-sidebar-cmd-2: valid/invalid コマンドが正しく描画される
// ======================================================================

test('[AC-sidebar-cmd-2] valid コマンドが data-valid="true" で描画される', async ({ page }) => {
  await boot(page, { commands: [VALID_COMMAND] });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  const item = page.locator('[data-testid="sidebar-command-item"][data-command-id="create-todo"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('data-valid', 'true');
  await expect(item).toContainText('create todo');
});

test('[AC-sidebar-cmd-2] invalid コマンドが data-valid="false" で描画され、警告アイコンを持つ', async ({ page }) => {
  await boot(page, { commands: [INVALID_COMMAND] });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  const item = page.locator('[data-testid="sidebar-command-item"][data-command-id="broken-cmd"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('data-valid', 'false');
  // 警告アイコンコンテナが存在する
  await expect(item.locator('.sidebar-cmd-warn')).toBeVisible();
  // 無効スタイルクラスが付いている
  await expect(item).toHaveClass(/sidebar-command-invalid/);
});

test('[AC-sidebar-cmd-2] valid と invalid が混在した場合は両方描画される', async ({ page }) => {
  await boot(page, { commands: [VALID_COMMAND, INVALID_COMMAND] });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  // 両アイテムが表示される
  await expect(page.locator('[data-testid="sidebar-command-item"]')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="sidebar-command-item"][data-command-id="create-todo"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="sidebar-command-item"][data-command-id="broken-cmd"]'),
  ).toBeVisible();
});

// ======================================================================
// AC-sidebar-cmd-3: クリックで CommandEditor が開く
// ======================================================================

test('[AC-sidebar-cmd-3] valid コマンドをクリックすると CommandEditor が開く (editable)', async ({ page }) => {
  await boot(page, { commands: [VALID_COMMAND] });

  // commands/create-todo.yaml を開いたときのソースエンドポイントをモック
  await page.route('**/api/commands/create-todo/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(
        json({
          id: 'create-todo',
          path: 'commands/create-todo.yaml',
          content: VALID_COMMAND_CONTENT,
          mtime: 2000,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  // サイドバーコマンドをクリック
  const item = page.locator('[data-testid="sidebar-command-item"][data-command-id="create-todo"]');
  await expect(item).toBeVisible();
  await item.click();

  // CommandEditor が表示される
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // 通常エディタは表示されない
  expect(await page.getByTestId('editor').count()).toBe(0);

  // 編集可能であること: YAML エディタと保存ボタンが存在する
  await expect(page.getByTestId('cmd-edit-yaml')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-save')).toBeVisible();

  // バリデーション: valid なので保存可能
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');
});

test('[AC-sidebar-cmd-3] invalid コマンドをクリックしても CommandEditor が開き、編集・修正できる', async ({ page }) => {
  const INVALID_CONTENT = ['name: broken-cmd', 'steps: []'].join('\n');

  await boot(page, { commands: [INVALID_COMMAND] });

  await page.route('**/api/commands/broken-cmd/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(
        json({
          id: 'broken-cmd',
          path: 'commands/broken-cmd.yaml',
          content: INVALID_CONTENT,
          mtime: 3000,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  const item = page.locator('[data-testid="sidebar-command-item"][data-command-id="broken-cmd"]');
  await item.click();

  // CommandEditor が表示される (invalid でも開く)
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // バリデーション: invalid なので保存ボタンは aria-disabled
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'false');
  await expect(page.getByTestId('cmd-edit-save')).toHaveAttribute('aria-disabled', 'true');
});

// ======================================================================
// AC-sidebar-cmd-4: コマンドが空のとき「コマンドがありません」
// ======================================================================

test('[AC-sidebar-cmd-4] コマンドが空なら「コマンドがありません」が表示される', async ({ page }) => {
  await boot(page, { commands: [] });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  await expect(page.getByTestId('sidebar-commands-empty')).toBeVisible();
  await expect(page.getByTestId('sidebar-commands-empty')).toContainText('コマンドがありません');
});

// ======================================================================
// AC-sidebar-cmd-5: セクションヘッダで折り畳み/展開
// ======================================================================

test('[AC-sidebar-cmd-5] セクションヘッダをクリックすると折り畳み、再クリックで展開する', async ({ page }) => {
  await boot(page, { commands: [VALID_COMMAND] });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  // 初期状態: 展開されている
  const item = page.locator('[data-testid="sidebar-command-item"][data-command-id="create-todo"]');
  await expect(item).toBeVisible();

  // ヘッダをクリックして折り畳む
  await page.getByTestId('sidebar-commands-section-toggle').click();
  await expect(item).not.toBeVisible();

  // もう一度クリックして展開する
  await page.getByTestId('sidebar-commands-section-toggle').click();
  await expect(item).toBeVisible();
});
