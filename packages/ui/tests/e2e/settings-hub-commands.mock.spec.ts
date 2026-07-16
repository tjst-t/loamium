/**
 * 設定ハブ スマートコマンド管理 mock テスト (Sa100c6-3)。
 *
 * page.route で API をモックし、ブラウザ上で UI の動作を検証する。
 * サーバーは起動しない。
 *
 * [AC-Sa100c6-3-1] 一覧(絞り込み)・新規・削除・選択→param/step 編集→保存。
 *   param/step は追加/編集(確定済みも編集ボタンで後から変更)/削除/並べ替えでき、
 *   編集可能タイトルヘッダ + フッタ(保存/キャンセル/試し実行/削除)。
 * [AC-Sa100c6-3-2] フッタ『試し実行』で POST /api/commands/{id}/run を叩き結果表示。
 *   保存/削除は監査 + LOAMIUM_MODE クランプ。
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

/** テスト用コマンド一覧 */
const CMD_LIST = [
  {
    id: 'todo-add',
    name: 'Todoを追加',
    description: 'ジャーナルにTodoを追記する',
    params: [{ name: 'task', label: 'タスク名', type: 'string', required: true }],
    valid: true,
    path: 'system/commands/todo-add.yaml',
  },
  {
    id: 'memo-add',
    name: 'メモを追加',
    description: '',
    params: [],
    valid: true,
    path: 'system/commands/memo-add.yaml',
  },
];

/** todo-add の YAML ソース */
const TODO_ADD_YAML = `name: Todoを追加
description: ジャーナルにTodoを追記する
params:
  - name: task
    label: タスク名
    type: string
    required: true
steps:
  - kind: journal-append
    content: '- [ ] task'
`;

/** memo-add の YAML ソース */
const MEMO_ADD_YAML = `name: メモを追加
description: ''
steps:
  - kind: journal-append
    content: メモ
`;

/** 共通ブートストラップ */
async function boot(page: Page, opts?: {
  mode?: 'full' | 'read-only' | 'append-only';
  commands?: unknown[];
  todoYaml?: string;
}): Promise<{
  unexpected: string[];
  putCommandCalls: Array<{ url: string; body: unknown }>;
  deleteSystemCalls: string[];
  runCalls: Array<{ url: string; body: unknown }>;
}> {
  const unexpected = await installCatchAll(page);
  const mode = opts?.mode ?? 'full';
  const cmdList = opts?.commands ?? CMD_LIST;
  const todoYaml = opts?.todoYaml ?? TODO_ADD_YAML;

  const putCommandCalls: Array<{ url: string; body: unknown }> = [];
  const deleteSystemCalls: string[] = [];
  const runCalls: Array<{ url: string; body: unknown }> = [];

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

  // スマートフォルダ (テンプレートタブ互換)
  await page.route('**/api/smart-folders', (route) => {
    if (route.request().url().includes('/notes')) { void route.fallback(); return; }
    void route.fulfill(json({ version: 1, items: [] }));
  });

  // system-files source (DELETE /api/system-files/{path}/source)
  await page.route('**/api/system-files/**/source', (route) => {
    if (route.request().method() === 'DELETE') {
      deleteSystemCalls.push(route.request().url());
      void route.fulfill(json({ path: 'system/commands/todo-add.yaml', deleted: true }));
      return;
    }
    void route.fallback();
  });

  // system-files 一覧
  await page.route('**/api/system-files', (route) => {
    void route.fulfill(json({ files: [] }));
  });

  // コマンド一覧
  await page.route('**/api/commands', (route) => {
    const url = route.request().url();
    // /run はフォールバック
    if (url.includes('/run')) { void route.fallback(); return; }
    // /source はフォールバック
    if (url.includes('/source')) { void route.fallback(); return; }
    void route.fulfill(json({ commands: cmdList }));
  });

  // コマンド source 読み取り
  await page.route('**/api/commands/todo-add/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ id: 'todo-add', path: 'system/commands/todo-add.yaml', content: todoYaml, mtime: 1000 }));
    } else if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      putCommandCalls.push({ url: route.request().url(), body });
      void route.fulfill(json({ id: 'todo-add', path: 'system/commands/todo-add.yaml', created: false, mtime: 2000 }));
    } else {
      void route.fallback();
    }
  });

  await page.route('**/api/commands/memo-add/source', (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      void route.fulfill(json({ id: 'memo-add', path: 'system/commands/memo-add.yaml', content: MEMO_ADD_YAML, mtime: 1001 }));
    } else if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      putCommandCalls.push({ url: route.request().url(), body });
      void route.fulfill(json({ id: 'memo-add', path: 'system/commands/memo-add.yaml', created: false, mtime: 2001 }));
    } else {
      void route.fallback();
    }
  });

  // new-command source (新規作成用)
  await page.route('**/api/commands/new-command-*/source', (route) => {
    const method = route.request().method();
    const url = route.request().url();
    // stem を URL から取り出す
    const stem = url.split('/api/commands/')[1]?.split('/source')[0] ?? 'new-command';
    if (method === 'PUT') {
      const body: unknown = route.request().postDataJSON();
      putCommandCalls.push({ url, body });
      void route.fulfill(json({ id: stem, path: `system/commands/${stem}.yaml`, created: true, mtime: 9999 }));
    } else {
      void route.fulfill(json({ id: stem, path: `system/commands/${stem}.yaml`, content: 'name: 新しいコマンド\nsteps:\n  - kind: journal-append\n    content: \'\'\n', mtime: 9999 }));
    }
  });

  // コマンド実行
  await page.route('**/api/commands/todo-add/run', (route) => {
    const body: unknown = route.request().postDataJSON();
    runCalls.push({ url: route.request().url(), body });
    void route.fulfill(json({
      results: [{ kind: 'journal-append', ok: true, path: JOURNAL_PATH }],
      openPath: JOURNAL_PATH,
    }));
  });

  await page.route('**/api/commands/memo-add/run', (route) => {
    const body: unknown = route.request().postDataJSON();
    runCalls.push({ url: route.request().url(), body });
    void route.fulfill(json({
      results: [{ kind: 'journal-append', ok: true, path: JOURNAL_PATH }],
      openPath: JOURNAL_PATH,
    }));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();

  return { unexpected, putCommandCalls, deleteSystemCalls, runCalls };
}

/** 設定画面を開き commands タブへ遷移 */
async function openCommandsTab(page: Page): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.locator('[data-testid="settings-nav-item"][data-group="commands"]').click();
  await expect(page.locator('[data-testid="md-panel"][data-group="commands"]')).toBeVisible();
}

// ============================================================
// [AC-Sa100c6-3-1] master-detail 基本構造
// ============================================================

test('[AC-Sa100c6-3-1] コマンドタブで master-detail が表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await expect(page.locator('[data-testid="md-panel"][data-group="commands"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-master"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-items"][data-items="commands"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-filter"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-new"]')).toBeVisible();
});

test('[AC-Sa100c6-3-1] 一覧に md-item が並ぶ (todo-add / memo-add)', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="md-item"][data-id="todo-add"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="memo-add"]')).toBeVisible();
});

test('[AC-Sa100c6-3-1] md-item をクリックすると md-detail が表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  // 最初のアイテムが自動選択されるまで待つ
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

  // memo-add をクリック
  await page.locator('[data-testid="md-item"][data-id="memo-add"]').click();

  // detail-title に名前が表示される
  await expect(page.getByTestId('detail-title')).toHaveValue('メモを追加', { timeout: 5000 });

  // 本体が表示される
  await expect(page.getByTestId('cmd-detail-body')).toBeVisible();
});

test('[AC-Sa100c6-3-1] detail-path にファイルパスが表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();

  await expect(page.getByTestId('detail-path')).toContainText('system/commands/todo-add.yaml');
});

test('[AC-Sa100c6-3-1] フッタに保存/キャンセル/試し実行/削除ボタンが表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await expect(page.getByTestId('md-detail-footer')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('md-save')).toBeVisible();
  await expect(page.getByTestId('md-cancel')).toBeVisible();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible();
  await expect(page.getByTestId('md-delete')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-3-1] 絞り込み
// ============================================================

test('[AC-Sa100c6-3-1] md-filter 入力で絞り込みができる', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(2);

  await page.getByTestId('md-filter-input').fill('Todo');

  await expect(page.locator('[data-testid="md-item"][data-id="todo-add"]')).toBeVisible();
  await expect(page.locator('[data-testid="md-item"][data-id="memo-add"]')).not.toBeVisible();
});

test('[AC-Sa100c6-3-1] 絞り込みをクリアすると全件戻る', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.getByTestId('md-filter-input').fill('Todo');
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(1);

  await page.getByTestId('md-filter-input').fill('');
  await expect(page.locator('[data-testid="md-item"]')).toHaveCount(2);
});

// ============================================================
// [AC-Sa100c6-3-1] param 表示
// ============================================================

test('[AC-Sa100c6-3-1] todo-add の param 行が表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

  // todo-add は自動選択 (最初) または手動クリック
  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();

  // param 行を待つ
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="task"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="task"]')).toHaveAttribute('data-required', 'true');
});

test('[AC-Sa100c6-3-1] param 行に編集ボタンと削除ボタンが表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="task"]')).toBeVisible({ timeout: 5000 });

  // cmd-param-edit ボタン (index=0)
  await expect(page.locator('[data-testid="cmd-param-edit"][data-index="0"]')).toBeVisible();
  await expect(page.locator('[data-testid="cmd-param-delete"][data-index="0"]')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-3-1] param 編集モーダル (確定済み行も後から編集可)
// ============================================================

test('[AC-Sa100c6-3-1] param 編集ボタンで param-edit-modal が開く', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-param-edit"][data-index="0"]')).toBeVisible({ timeout: 5000 });

  await page.locator('[data-testid="cmd-param-edit"][data-index="0"]').click();

  await expect(page.getByTestId('param-edit-modal')).toBeVisible();
  await expect(page.getByTestId('param-edit-name')).toHaveValue('task');
});

test('[AC-Sa100c6-3-1] param を編集して保存すると param 行が更新される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-param-edit"][data-index="0"]')).toBeVisible({ timeout: 5000 });

  // モーダルを開く
  await page.locator('[data-testid="cmd-param-edit"][data-index="0"]').click();
  await expect(page.getByTestId('param-edit-modal')).toBeVisible();

  // 名前を変更
  await page.getByTestId('param-edit-name').fill('newTask');
  await page.getByTestId('param-edit-save').click();

  // モーダルが閉じて param 行が更新される
  await expect(page.getByTestId('param-edit-modal')).not.toBeVisible();
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="newTask"]')).toBeVisible();
});

test('[AC-Sa100c6-3-1] ＋パラメータ追加ボタンで param-edit-modal(新規) が開く', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-param-add')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-param-add').click();

  await expect(page.getByTestId('param-edit-modal')).toBeVisible();
  await expect(page.getByTestId('param-edit-title')).toContainText('パラメータを追加');
});

test('[AC-Sa100c6-3-1] param を追加すると一覧に追加される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-param-add')).toBeVisible({ timeout: 5000 });

  // 追加
  await page.getByTestId('cmd-param-add').click();
  await page.getByTestId('param-edit-name').fill('priority');
  await page.getByTestId('param-edit-save').click();

  // 新しい param 行が追加される
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="priority"]')).toBeVisible();
});

test('[AC-Sa100c6-3-1] param の削除ボタンで行が削除される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="task"]')).toBeVisible({ timeout: 5000 });

  // 削除
  await page.locator('[data-testid="cmd-param-delete"][data-index="0"]').click();

  await expect(page.locator('[data-testid="cmd-param-row"][data-name="task"]')).not.toBeVisible();
  await expect(page.getByTestId('cmd-params-empty')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-3-1] step 表示
// ============================================================

test('[AC-Sa100c6-3-1] todo-add の step 行が表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();

  await expect(page.locator('[data-testid="cmd-step-row"][data-kind="journal-append"]')).toBeVisible({ timeout: 5000 });
});

test('[AC-Sa100c6-3-1] step 行に編集ボタンと削除ボタンが表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-step-row"]')).toBeVisible({ timeout: 5000 });

  await expect(page.locator('[data-testid="cmd-step-edit"][data-index="0"]')).toBeVisible();
  await expect(page.locator('[data-testid="cmd-step-delete"][data-index="0"]')).toBeVisible();
});

test('[AC-Sa100c6-3-1] step 編集ボタンで step-edit-modal が開く', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-step-edit"][data-index="0"]')).toBeVisible({ timeout: 5000 });

  await page.locator('[data-testid="cmd-step-edit"][data-index="0"]').click();

  await expect(page.getByTestId('step-edit-modal')).toBeVisible();
  await expect(page.getByTestId('step-edit-kind')).toHaveValue('journal-append');
});

test('[AC-Sa100c6-3-1] step content を編集して保存すると row が更新される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-step-edit"][data-index="0"]')).toBeVisible({ timeout: 5000 });

  await page.locator('[data-testid="cmd-step-edit"][data-index="0"]').click();
  await expect(page.getByTestId('step-edit-modal')).toBeVisible();

  // content を変更
  await page.getByTestId('step-edit-content').fill('更新したテキスト');
  await page.getByTestId('step-edit-save').click();

  await expect(page.getByTestId('step-edit-modal')).not.toBeVisible();
  // step 行は残る (kind は同じ)
  await expect(page.locator('[data-testid="cmd-step-row"][data-kind="journal-append"]')).toBeVisible();
});

test('[AC-Sa100c6-3-1] ＋ステップ追加ボタンで step-edit-modal(新規) が開く', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-step-add')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-step-add').click();

  await expect(page.getByTestId('step-edit-modal')).toBeVisible();
  await expect(page.getByTestId('step-edit-title')).toContainText('ステップを追加');
});

test('[AC-Sa100c6-3-1] step を追加すると一覧に追加される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-step-add')).toBeVisible({ timeout: 5000 });

  const stepsBefore = await page.locator('[data-testid="cmd-step-row"]').count();

  // 追加
  await page.getByTestId('cmd-step-add').click();
  await page.getByTestId('step-edit-content').fill('追加コンテンツ');
  await page.getByTestId('step-edit-save').click();

  const stepsAfter = await page.locator('[data-testid="cmd-step-row"]').count();
  expect(stepsAfter).toBe(stepsBefore + 1);
});

test('[AC-Sa100c6-3-1] step の削除ボタンで行が削除される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-step-row"]')).toHaveCount(1, { timeout: 5000 });

  await page.locator('[data-testid="cmd-step-delete"][data-index="0"]').click();

  await expect(page.locator('[data-testid="cmd-step-row"]')).toHaveCount(0);
  await expect(page.getByTestId('cmd-steps-empty')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-3-1] 保存: フッタの保存ボタン → PUT /api/commands/{id}/source
// ============================================================

test('[AC-Sa100c6-3-1] 保存ボタンクリックで PUT /api/commands/{id}/source が呼ばれる', async ({ page }) => {
  const { putCommandCalls } = await boot(page);
  await openCommandsTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();

  // 説明を変更してから保存
  await expect(page.getByTestId('cmd-description')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('cmd-description').fill('更新した説明');

  await page.getByTestId('md-save').click();

  await expect(async () => {
    expect(putCommandCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  expect(putCommandCalls[0]?.url).toContain('/api/commands/todo-add/source');
  const body = putCommandCalls[0]?.body as { content: string };
  expect(body.content).toContain('更新した説明');
});

test('[AC-Sa100c6-3-1] タイトルヘッダ編集で name が YAML に反映される', async ({ page }) => {
  const { putCommandCalls } = await boot(page);
  await openCommandsTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('detail-title').fill('新しい名前');
  await page.getByTestId('md-save').click();

  await expect(async () => {
    expect(putCommandCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  const body = putCommandCalls[0]?.body as { content: string };
  expect(body.content).toContain('新しい名前');
});

test('[AC-Sa100c6-3-1] param 追加後に保存すると PUT body に param が含まれる', async ({ page }) => {
  const { putCommandCalls } = await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="memo-add"]').click();
  await expect(page.getByTestId('cmd-param-add')).toBeVisible({ timeout: 5000 });

  // param 追加
  await page.getByTestId('cmd-param-add').click();
  await page.getByTestId('param-edit-name').fill('newparam');
  await page.getByTestId('param-edit-save').click();

  // 保存
  await page.getByTestId('md-save').click();

  await expect(async () => {
    const putCall = putCommandCalls.find((c) => c.url.includes('memo-add'));
    expect(putCall).toBeDefined();
    const body = putCall?.body as { content: string };
    expect(body.content).toContain('newparam');
  }).toPass({ timeout: 5000 });
});

test('[AC-S5a66e4-5-2] agent-run step 追加: maxTurns/timeoutSec が YAML に数値としてシリアライズされる', async ({ page }) => {
  const { putCommandCalls } = await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="memo-add"]').click();
  await expect(page.getByTestId('cmd-step-add')).toBeVisible({ timeout: 5000 });

  // agent-run step を追加
  await page.getByTestId('cmd-step-add').click();
  await expect(page.getByTestId('step-edit-modal')).toBeVisible();
  await page.getByTestId('step-edit-kind').selectOption('agent-run');

  await page.getByTestId('step-edit-prompt').fill('議事録を要約して');
  await page.getByTestId('step-edit-maxTurns').fill('8');
  await page.getByTestId('step-edit-timeoutSec').fill('300');
  await page.getByTestId('step-edit-save').click();
  await expect(page.getByTestId('step-edit-modal')).not.toBeVisible();

  // step 行に agent-run が並ぶ
  await expect(page.locator('[data-testid="cmd-step-row"][data-kind="agent-run"]')).toBeVisible();

  // 保存
  await page.getByTestId('md-save').click();

  await expect(async () => {
    const putCall = putCommandCalls.find((c) => c.url.includes('memo-add'));
    expect(putCall).toBeDefined();
    const body = putCall?.body as { content: string };
    // 数値は引用符なし (文字列止まりでない) でシリアライズされること
    expect(body.content).toMatch(/maxTurns:\s*8(\s|$)/m);
    expect(body.content).toMatch(/timeoutSec:\s*300(\s|$)/m);
    // 引用符付きの文字列としては出力されないこと
    expect(body.content).not.toContain('maxTurns: "8"');
    expect(body.content).not.toContain("maxTurns: '8'");
    expect(body.content).not.toContain('timeoutSec: "300"');
    expect(body.content).toContain('prompt:');
  }).toPass({ timeout: 5000 });
});

// ============================================================
// [AC-Sa100c6-3-1] 新規作成
// ============================================================

test('[AC-Sa100c6-3-1] md-new クリックで新規コマンドが作成される', async ({ page }) => {
  const { putCommandCalls } = await boot(page);
  await openCommandsTab(page);

  await page.getByTestId('md-new').click();

  await expect(async () => {
    expect(putCommandCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  // PUT URL に new-command が含まれる
  expect(putCommandCalls[0]?.url).toContain('/api/commands/new-command-');

  // detail-title が表示される
  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
});

// ============================================================
// [AC-Sa100c6-3-1] 削除
// ============================================================

test('[AC-Sa100c6-3-1] 削除ボタンクリックで DELETE /api/system-files が呼ばれる', async ({ page }) => {
  const { deleteSystemCalls } = await boot(page);
  await openCommandsTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();

  // confirm をオート承認
  page.on('dialog', (dialog) => void dialog.accept());

  await page.getByTestId('md-delete').click();

  await expect(async () => {
    expect(deleteSystemCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  expect(deleteSystemCalls[0]).toContain('/api/system-files/');
  expect(deleteSystemCalls[0]).toContain('todo-add');
});

// ============================================================
// [AC-Sa100c6-3-2] 試し実行 (param なし: 即実行)
// ============================================================

test('[AC-Sa100c6-3-2] 試し実行で POST /api/commands/{id}/run が呼ばれる (param なし)', async ({ page }) => {
  const { runCalls } = await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="memo-add"]').click();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-test-run').click();

  await expect(async () => {
    expect(runCalls.some((c) => c.url.includes('memo-add/run'))).toBe(true);
  }).toPass({ timeout: 8000 });
});

test('[AC-Sa100c6-3-2] 試し実行結果が cmd-run-result に表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="memo-add"]').click();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-test-run').click();

  // 結果表示
  await expect(page.getByTestId('cmd-run-result')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('[data-testid="step-result"][data-ok="true"]')).toBeVisible();
});

test('[AC-Sa100c6-3-2] param ありコマンドで試し実行すると param-form-modal が開く', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-test-run').click();

  // param フォームモーダルが開く
  await expect(page.getByTestId('param-form-modal')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('param-form-title')).toContainText('Todoを追加');
});

test('[AC-Sa100c6-3-2] param 入力後に実行すると POST /api/commands/{id}/run が呼ばれる', async ({ page }) => {
  const { runCalls } = await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-test-run').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible({ timeout: 5000 });

  // param 入力
  await page.locator('[data-testid="param-field-input"][data-name="task"]').fill('テストタスク');
  await page.getByTestId('param-form-submit').click();

  await expect(async () => {
    expect(runCalls.some((c) => c.url.includes('todo-add/run'))).toBe(true);
  }).toPass({ timeout: 8000 });
});

test('[AC-Sa100c6-3-2] 試し実行の run 結果で step-result が表示される', async ({ page }) => {
  const { runCalls } = await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.getByTestId('cmd-test-run')).toBeVisible({ timeout: 5000 });

  await page.getByTestId('cmd-test-run').click();
  await expect(page.getByTestId('param-form-modal')).toBeVisible({ timeout: 5000 });

  await page.locator('[data-testid="param-field-input"][data-name="task"]').fill('テストタスク');
  await page.getByTestId('param-form-submit').click();

  await expect(async () => {
    expect(runCalls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 8000 });

  await expect(page.getByTestId('cmd-run-result')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="step-result"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="step-result"][data-kind="journal-append"][data-ok="true"]')).toBeVisible();
});

// ============================================================
// [AC-Sa100c6-3-2] read-only モードで書込 UI が disabled
// ============================================================

test('[AC-Sa100c6-3-2] read-only モードでは保存/新規/削除ボタンが disabled', async ({ page }) => {
  await boot(page, { mode: 'read-only' });
  await openCommandsTab(page);

  await expect(page.getByTestId('md-detail-footer')).toBeVisible({ timeout: 5000 });

  await expect(page.getByTestId('md-new')).toBeDisabled();
  await expect(page.getByTestId('md-save')).toBeDisabled();
  await expect(page.getByTestId('md-delete')).toBeDisabled();
  await expect(page.getByTestId('cmd-test-run')).toBeDisabled();
});

test('[AC-Sa100c6-3-2] read-only モードでは detail-title が disabled', async ({ page }) => {
  await boot(page, { mode: 'read-only' });
  await openCommandsTab(page);

  await expect(page.getByTestId('detail-title')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('detail-title')).toBeDisabled();
});

test('[AC-Sa100c6-3-2] read-only モードでは param/step の編集/追加/削除ボタンが disabled', async ({ page }) => {
  await boot(page, { mode: 'read-only' });
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-param-row"]')).toBeVisible({ timeout: 5000 });

  await expect(page.locator('[data-testid="cmd-param-edit"]').first()).toBeDisabled();
  await expect(page.locator('[data-testid="cmd-param-delete"]').first()).toBeDisabled();
  await expect(page.getByTestId('cmd-param-add')).toBeDisabled();
  await expect(page.getByTestId('cmd-step-add')).toBeDisabled();
});

// ============================================================
// [COMPAT] 既存テンプレート/スマートフォルダタブが壊れていない
// ============================================================

test('[COMPAT] テンプレートタブが引き続き表示される', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="templates"]').click();

  await expect(page.locator('[data-testid="md-panel"][data-group="templates"]')).toBeVisible();
});

test('[COMPAT] スマートフォルダタブが引き続き表示される', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar-settings').click();
  await page.locator('[data-testid="settings-nav-item"][data-group="smart-folders"]').click();

  await expect(page.locator('[data-testid="md-panel"][data-group="smart-folders"]')).toBeVisible();
});

// ============================================================
// エラー / エッジケース
// ============================================================

test('[EDGE] コマンド一覧が空のとき空メッセージが表示される', async ({ page }) => {
  await boot(page, { commands: [] });
  await openCommandsTab(page);

  await expect(page.locator('[data-testid="md-items-empty"]')).toBeVisible({ timeout: 5000 });
});

test('[EDGE] ステップ 0 件で保存しようとするとエラー表示される', async ({ page }) => {
  await boot(page);
  await openCommandsTab(page);

  await page.locator('[data-testid="md-item"][data-id="todo-add"]').click();
  await expect(page.locator('[data-testid="cmd-step-row"]')).toHaveCount(1, { timeout: 5000 });

  // ステップを全削除
  await page.locator('[data-testid="cmd-step-delete"][data-index="0"]').click();

  // 保存
  await page.getByTestId('md-save').click();

  // エラーが表示される (ステップ 0 件はバリデーションエラー)
  await expect(page.locator('.md-save-error')).toBeVisible({ timeout: 3000 });
});
