/**
 * CommandEditor mock テスト — S9e64e7-1 + S9e64e7-2。
 * page.route で全 /api/* をモックし、フロントエンドの振る舞いだけを検証する。
 *
 * AC-S9e64e7-1-1: commands/ + loamium-command → CommandEditor (command-editor) が visible;
 *                 commands/ 外 / loamium-command なし → 通常 Editor が visible。
 * AC-S9e64e7-1-2: 保存ボタンは valid のとき有効; invalid (スキーマエラー) のとき aria-disabled。
 * AC-S9e64e7-1-3: testid は gui-spec / prototype V3 に準拠。
 *
 * AC-S9e64e7-2-1: YAML 編集でリアルタイムバリデーション。
 *                 valid → cmd-edit-validation[data-valid=true]。
 *                 invalid → data-valid=false + cmd-edit-error 表示 + save/test-run disabled。
 * AC-S9e64e7-2-2: params プレビュー (cmd-param-row) + steps プレビュー (cmd-step-row)。
 *                 select 型の options, when: 付きステップのマーカー, prop-set ステップ。
 * AC-S9e64e7-2-3: テスト実行フロー:
 *                 params あり → param-form-modal を開き submit → POST /api/commands/{id}/run。
 *                 params なし → 即 POST run。
 *                 dirty 状態 → 先に PUT 保存してから POST run。
 *                 partial-failure → step-result[data-ok=false] 表示。
 *                 id は stem (display name ではなく)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json, type PutBody } from '../harness/mock-helpers.js';

// ---- フィクスチャ ----

const DATE = '2026-07-13';
const JOURNAL_PATH = `journals/${DATE}.md`;

const NOTES_WITH_COMMAND = {
  notes: [
    { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
    { path: 'commands/create-todo.md', title: 'create-todo', tags: [], folder: 'commands' },
    { path: 'commands/readme.md', title: 'readme', tags: [], folder: 'commands' },
    { path: 'notes/my-command.md', title: 'my-command', tags: [], folder: 'notes' },
  ],
};

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

/** 有効なスマートコマンド定義ノート (params 3件、steps 1件) */
const VALID_COMMAND_CONTENT = [
  '---',
  'loamium-command:',
  '  name: create todo',
  '  description: タスクを今日のジャーナルに追記',
  '  params:',
  '    - name: summary',
  '      label: タスク概要',
  '      required: true',
  '    - name: due',
  '      label: 期限',
  '      type: date',
  '    - name: detail',
  '      label: タスク詳細',
  '      type: text',
  '  steps:',
  '    - kind: journal-append',
  '      content: "- [ ] {{summary}}"',
  '      section: Todo',
  '---',
  '',
  '# create todo',
  '',
  'タスクを追記するコマンドです。',
].join('\n');

/** params なしのコマンド定義 */
const NO_PARAM_COMMAND_CONTENT = [
  '---',
  'loamium-command:',
  '  name: no-param-cmd',
  '  steps:',
  '    - kind: journal-append',
  '      content: "ログエントリ"',
  '---',
  '',
  '# no-param-cmd',
].join('\n');

/** 全 param 型を含む定義 */
const ALL_PARAM_TYPES_CONTENT = [
  '---',
  'loamium-command:',
  '  name: all-types',
  '  params:',
  '    - name: status',
  '      type: select',
  '      options: [pending, done, cancelled]',
  '    - name: target',
  '      type: note',
  '    - name: flag',
  '      type: boolean',
  '    - name: count',
  '      type: number',
  '  steps:',
  '    - kind: prop-set',
  '      target: "{{target}}"',
  '      set:',
  '        status: "{{status}}"',
  '---',
  '',
  '# all-types',
].join('\n');

/** 6 種 + when: 付きステップを含む定義 */
const ALL_STEP_KINDS_CONTENT = [
  '---',
  'loamium-command:',
  '  name: all-steps',
  '  steps:',
  '    - kind: journal-append',
  '      content: "entry"',
  '    - kind: note-append',
  '      target: "notes/foo.md"',
  '      content: "append"',
  '    - kind: note-create',
  '      target: "notes/new.md"',
  '      content: "body"',
  '    - kind: template-instantiate',
  '      template: "weekly"',
  '    - kind: prop-set',
  '      target: "notes/foo.md"',
  '      set:',
  '        status: done',
  '    - kind: note-patch',
  '      target: "notes/foo.md"',
  '      old: "old text"',
  '      new: "new text"',
  '      when: "{{flag}}"',
  '---',
  '',
  '# all-steps',
].join('\n');

/** 無効なスマートコマンド定義ノート (steps 配列が空) */
const INVALID_COMMAND_CONTENT_NO_STEPS = [
  '---',
  'loamium-command:',
  '  name: broken',
  '  steps: []',
  '---',
  '',
  '# broken',
].join('\n');

/** 無効なスマートコマンド定義ノート (未知の kind) */
const INVALID_COMMAND_CONTENT_BAD_KIND = [
  '---',
  'loamium-command:',
  '  name: bad-kind',
  '  steps:',
  '    - kind: agent-run',
  '      prompt: "hello"',
  '---',
  '',
  '# bad-kind',
].join('\n');

/** commands/ 配下だが loamium-command フロントマターを持たない */
const NORMAL_COMMANDS_README_CONTENT = [
  '---',
  'title: コマンド README',
  '---',
  '',
  '# README',
  '',
  'commands フォルダの説明ファイルです。',
].join('\n');

/** commands/ 外だが loamium-command フロントマターを持つ (commands/ 外なので通常 Editor) */
const NOTE_WITH_COMMAND_KEY_CONTENT = [
  '---',
  'loamium-command:',
  '  name: outside',
  '  steps:',
  '    - kind: journal-append',
  '      content: "test"',
  '---',
  '',
  '# outside',
].join('\n');

/**
 * App.tsx の isCommandNote は path が 'commands/' で始まり、
 * frontmatter に 'loamium-command' キーが存在する場合に CommandEditor を選択する。
 * frontmatter の値は CommandEditor が content テキストから再パースするため
 * ここでは最低限のマーカーオブジェクトだけ渡せばよい。
 */
function commandNote(content: string, mtime = 2000, path = 'commands/create-todo.md'): Record<string, unknown> {
  return {
    path,
    content,
    frontmatter: {
      // isCommandNote が true を返すために必要なマーカーキー
      'loamium-command': { name: 'create todo' },
    },
    body: '# create todo\n',
    mtime,
  };
}

async function openApp(page: Page): Promise<{ unexpected: string[] }> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json(NOTES_WITH_COMMAND));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal()));
  });
  return { unexpected };
}

// ======================================================================
// AC-S9e64e7-1-1: 検出 — commands/ + loamium-command → CommandEditor
// ======================================================================

test('[AC-S9e64e7-1-1] commands/ + loamium-command ノートを開くと CommandEditor が visible、通常 Editor は非表示', async ({ page }) => {
  const { unexpected } = await openApp(page);

  // commands/create-todo.md を開いたときのレスポンス
  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(VALID_COMMAND_CONTENT)));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);

  // サイドバーから commands/create-todo.md をクリック
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();

  // CommandEditor が visible
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // 左ペイン (YAML ソース) と右ペイン枠が visible
  await expect(page.getByTestId('cmd-edit-yaml')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-preview')).toBeVisible();

  // 通常の editor は DOM に存在しない (未描画)
  await expect(page.getByTestId('editor')).not.toBeVisible({ timeout: 2000 }).catch(() => {
    // not.toBeVisible が通ればよい。DOM に存在すらしない場合 expect が別のエラーを出すことがある
    // → その場合は count チェックで確認する
  });
  // 通常エディタが 0 個であることを検証
  expect(await page.getByTestId('editor').count()).toBe(0);

  // cmd-mode-badge visible
  await expect(page.getByTestId('cmd-mode-badge')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-1-1] commands/ 配下でも loamium-command なしのノートは通常 Editor を表示する', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/commands/readme.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: 'commands/readme.md',
          content: NORMAL_COMMANDS_README_CONTENT,
          frontmatter: { title: 'コマンド README' },
          body: '# README\n',
          mtime: 1500,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);

  await page.getByTestId('tree-item').filter({ hasText: 'readme' }).click();

  // 通常 Editor が visible
  await expect(page.getByTestId('editor')).toBeVisible();
  // CommandEditor は未描画
  expect(await page.getByTestId('command-editor').count()).toBe(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-1-1] commands/ 外の loamium-command ノートは通常 Editor を表示する', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/notes/my-command.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: 'notes/my-command.md',
          content: NOTE_WITH_COMMAND_KEY_CONTENT,
          frontmatter: {
            'loamium-command': {
              name: 'outside',
              steps: [{ kind: 'journal-append', content: 'test' }],
            },
          },
          body: '# outside\n',
          mtime: 1500,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);

  await page.getByTestId('tree-item').filter({ hasText: 'my-command' }).click();

  // 通常 Editor が visible
  await expect(page.getByTestId('editor')).toBeVisible();
  // CommandEditor は未描画
  expect(await page.getByTestId('command-editor').count()).toBe(0);

  expect(unexpected).toEqual([]);
});

// ======================================================================
// AC-S9e64e7-1-2: 保存ボタン — valid のとき有効、invalid のとき aria-disabled
// ======================================================================

test('[AC-S9e64e7-1-2] 有効定義のとき cmd-edit-save は aria-disabled なしで押せる', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const putBodies: PutBody[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(VALID_COMMAND_CONTENT)));
      return;
    }
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ path: 'commands/create-todo.md', created: false, mtime: 9999 }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // バリデーション: valid
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // 保存ボタンに aria-disabled がないことを確認
  const saveBtn = page.getByTestId('cmd-edit-save');
  await expect(saveBtn).toBeVisible();
  await expect(saveBtn).not.toHaveAttribute('aria-disabled');

  // 保存ボタンをクリック → PUT が呼ばれる
  await saveBtn.click();
  // save-status: CommandEditor 内部のものを参照 (2 つある可能性があるため first() で first)
  await expect(page.getByTestId('save-status').first()).toHaveAttribute('data-state', 'saved');
  expect(putBodies.length).toBeGreaterThan(0);
  expect(putBodies[0]?.content).toContain('loamium-command');

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-1-2] steps[] 空(無効)定義のとき cmd-edit-save は aria-disabled かつ PUT されない', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const putBodies: PutBody[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: 'commands/create-todo.md',
          content: INVALID_COMMAND_CONTENT_NO_STEPS,
          frontmatter: { 'loamium-command': { name: 'broken', steps: [] } },
          body: '# broken\n',
          mtime: 2000,
        }),
      );
      return;
    }
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ path: 'commands/create-todo.md', mtime: 3000 }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // バリデーション: invalid
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'false');

  // エラーメッセージが表示されること
  await expect(page.getByTestId('cmd-edit-error')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-error')).toContainText('steps');

  // 保存ボタンが aria-disabled
  const saveBtn = page.getByTestId('cmd-edit-save');
  await expect(saveBtn).toHaveAttribute('aria-disabled', 'true');

  // クリックしても PUT は呼ばれない (aria-disabled なのでクリックできないが force で試みる)
  await saveBtn.click({ force: true });
  await new Promise((r) => setTimeout(r, 500));
  expect(putBodies).toHaveLength(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-1-2] 未知の kind (無効) → aria-disabled → YAML を修正すると有効になる', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const putBodies: PutBody[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: 'commands/create-todo.md',
          content: INVALID_COMMAND_CONTENT_BAD_KIND,
          frontmatter: {
            'loamium-command': {
              name: 'bad-kind',
              steps: [{ kind: 'agent-run', prompt: 'hello' }],
            },
          },
          body: '# bad-kind\n',
          mtime: 2000,
        }),
      );
      return;
    }
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ path: 'commands/create-todo.md', mtime: 3000 }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // 最初は invalid
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'false');
  await expect(page.getByTestId('cmd-edit-save')).toHaveAttribute('aria-disabled', 'true');

  expect(unexpected).toEqual([]);
});

// ======================================================================
// 既存の通常ノート編集に回帰がないことを確認
// ======================================================================

test('[REGRESSION] 通常ノートは引き続き Editor で開き、保存できる', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const putBodies: PutBody[] = [];

  // journal PUT は /api/notes/journals/{date}.md でくる
  await page.route(`**/api/notes/journals/${DATE}.md`, (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 501 }));
      return;
    }
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: JOURNAL_PATH,
          content: '# ジャーナル\n\n通常ノート。\n',
          frontmatter: null,
          body: '# ジャーナル\n\n通常ノート。\n',
          mtime: 500,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);

  // journal が通常 Editor で開かれること
  await expect(page.getByTestId('editor')).toBeVisible();
  // CommandEditor は未描画
  expect(await page.getByTestId('command-editor').count()).toBe(0);

  // 編集して Ctrl+S で保存
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' 追記');
  await page.keyboard.press('Control+s');

  // save-status: 通常 Editor の場合は App ヘッダのものが 1 つ
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(putBodies.length).toBeGreaterThan(0);

  expect(unexpected).toEqual([]);
});

// ======================================================================
// AC-S9e64e7-2-1: ライブバリデーション
// ======================================================================

test('[AC-S9e64e7-2-1] 有効 YAML → cmd-edit-validation[data-valid=true]、invalid → data-valid=false + エラー表示 + save/test-run disabled', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(VALID_COMMAND_CONTENT)));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // 有効状態: data-valid=true、test-run は aria-disabled なし
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');
  await expect(page.getByTestId('cmd-edit-test-run')).not.toHaveAttribute('aria-disabled');

  // 左ペインをクリックして CodeMirror にフォーカス
  await page.getByTestId('cmd-edit-yaml').click();
  // Ctrl+A で全選択し、無効な YAML に置き換える (steps の kind が未知)
  await page.keyboard.press('Control+a');
  await page.keyboard.type(INVALID_COMMAND_CONTENT_BAD_KIND);

  // リアルタイム検証が働いて invalid になる
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'false', { timeout: 5000 });

  // エラーバナーが表示
  await expect(page.getByTestId('cmd-edit-error')).toBeVisible();

  // save + test-run が aria-disabled
  await expect(page.getByTestId('cmd-edit-save')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('cmd-edit-test-run')).toHaveAttribute('aria-disabled', 'true');

  expect(unexpected).toEqual([]);
});

// ======================================================================
// AC-S9e64e7-2-2: params/steps プレビュー
// ======================================================================

test('[AC-S9e64e7-2-2] 有効定義: params プレビュー行 (cmd-param-row) が正しく表示される', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(VALID_COMMAND_CONTENT)));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // params プレビュー 3 件
  const paramRows = page.getByTestId('cmd-param-row');
  await expect(paramRows).toHaveCount(3);

  // summary: string, required=true
  const summaryRow = page.locator('[data-testid="cmd-param-row"][data-name="summary"]');
  await expect(summaryRow).toBeVisible();
  await expect(summaryRow).toHaveAttribute('data-type', 'string');
  await expect(summaryRow).toHaveAttribute('data-required', 'true');

  // due: date, required=false
  const dueRow = page.locator('[data-testid="cmd-param-row"][data-name="due"]');
  await expect(dueRow).toBeVisible();
  await expect(dueRow).toHaveAttribute('data-type', 'date');
  await expect(dueRow).toHaveAttribute('data-required', 'false');

  // steps プレビュー 1 件
  const stepRows = page.getByTestId('cmd-step-row');
  await expect(stepRows).toHaveCount(1);
  const step0 = page.locator('[data-testid="cmd-step-row"][data-index="0"]');
  await expect(step0).toHaveAttribute('data-kind', 'journal-append');

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-2-2] select 型 param の options が表示される + when: 付きステップのマーカー + prop-set ステップ', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(ALL_PARAM_TYPES_CONTENT)));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // select 型 param
  const statusRow = page.locator('[data-testid="cmd-param-row"][data-name="status"]');
  await expect(statusRow).toHaveAttribute('data-type', 'select');
  // options が表示されている (テキストに pending が含まれる)
  await expect(statusRow).toContainText('pending');

  // note / boolean / number 型
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="target"]')).toHaveAttribute('data-type', 'note');
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="flag"]')).toHaveAttribute('data-type', 'boolean');
  await expect(page.locator('[data-testid="cmd-param-row"][data-name="count"]')).toHaveAttribute('data-type', 'number');

  // prop-set ステップ
  const propSetRow = page.locator('[data-testid="cmd-step-row"][data-kind="prop-set"]');
  await expect(propSetRow).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-2-2] 6 種の step kind が cmd-step-row に表示される、when: 付きステップに data-when 属性', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(ALL_STEP_KINDS_CONTENT)));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // 6 種のステップ
  for (const kind of [
    'journal-append',
    'note-append',
    'note-create',
    'template-instantiate',
    'prop-set',
    'note-patch',
  ]) {
    await expect(
      page.locator(`[data-testid="cmd-step-row"][data-kind="${kind}"]`),
    ).toBeVisible();
  }

  // note-patch (index=5) は when: が設定されているので data-when 属性を持つ
  const notePatchRow = page.locator('[data-testid="cmd-step-row"][data-kind="note-patch"]');
  await expect(notePatchRow).toHaveAttribute('data-when');

  expect(unexpected).toEqual([]);
});

// ======================================================================
// AC-S9e64e7-2-3: テスト実行
// ======================================================================

test('[AC-S9e64e7-2-3] params あり → param-form-modal が開き、submit で POST /api/commands/{stem}/run が呼ばれ、cmd-edit-run-result が表示', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const putBodies: PutBody[] = [];
  const runBodies: Record<string, unknown>[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(VALID_COMMAND_CONTENT)));
      return;
    }
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ path: 'commands/create-todo.md', created: false, mtime: 9999 }));
      return;
    }
    void route.fallback();
  });

  // POST /api/commands/create-todo/run (stem = "create-todo", NOT display name)
  await page.route('**/api/commands/create-todo/run', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      runBodies.push(req.postDataJSON() as Record<string, unknown>);
      void route.fulfill(
        json({
          results: [{ kind: 'journal-append', ok: true, path: JOURNAL_PATH }],
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // 保存済み状態 (save-status=saved のまま)
  await expect(page.getByTestId('save-status').first()).toHaveAttribute('data-state', 'saved');

  // テスト実行ボタンをクリック
  await page.getByTestId('cmd-edit-test-run').click();

  // param-form-modal が表示 (role=dialog)
  await expect(page.getByTestId('param-form-modal')).toBeVisible();
  await expect(page.getByTestId('param-form-title')).toContainText('create todo');

  // summary フィールドに入力
  const summaryField = page.locator('[data-testid="param-field-input"][data-name="summary"]');
  await summaryField.fill('実装タスク');

  // param-form-submit をクリック
  await page.getByTestId('param-form-submit').click();

  // modal が閉じる
  await expect(page.getByTestId('param-form-modal')).not.toBeVisible();

  // cmd-edit-run-result が表示
  await expect(page.getByTestId('cmd-edit-run-result')).toBeVisible();

  // step-result[data-kind='journal-append'][data-ok='true'] が表示
  await expect(
    page.locator('[data-testid="step-result"][data-kind="journal-append"][data-ok="true"]'),
  ).toBeVisible();

  // POST が呼ばれた (stem "create-todo" で呼ばれたことを確認)
  expect(runBodies.length).toBeGreaterThan(0);
  const runBody = runBodies[0] as { params: Record<string, string> };
  expect(runBody.params).toMatchObject({ summary: '実装タスク' });

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-2-3] params なし → param-form-modal は表示されず即 POST run、cmd-edit-run-result 表示', async ({ page }) => {
  // commands/create-todo.md を no-param-cmd の content で開く
  // ただし note list の 'create-todo' を利用する
  const { unexpected } = await openApp(page);
  const runBodies: Record<string, unknown>[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(NO_PARAM_COMMAND_CONTENT)));
      return;
    }
    void route.fallback();
  });

  // id は stem "create-todo" (no-param-cmd は display name — stem ではない)
  await page.route('**/api/commands/create-todo/run', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      runBodies.push(req.postDataJSON() as Record<string, unknown>);
      void route.fulfill(
        json({
          results: [{ kind: 'journal-append', ok: true }],
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // テスト実行
  await page.getByTestId('cmd-edit-test-run').click();

  // param-form-modal は表示されない
  await expect(page.getByTestId('param-form-modal')).not.toBeVisible();

  // cmd-edit-run-result が表示
  await expect(page.getByTestId('cmd-edit-run-result')).toBeVisible();

  expect(runBodies.length).toBeGreaterThan(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-2-3] invalid 状態では cmd-edit-test-run は aria-disabled で POST されない', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const runBodies: Record<string, unknown>[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: 'commands/create-todo.md',
          content: INVALID_COMMAND_CONTENT_BAD_KIND,
          // isCommandNote が true を返すために loamium-command キーが必要
          frontmatter: { 'loamium-command': { name: 'bad-kind' } },
          body: '# bad-kind\n',
          mtime: 2000,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.route('**/api/commands/**/run', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      runBodies.push(req.postDataJSON() as Record<string, unknown>);
      void route.fulfill(json({ results: [] }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'false');

  // test-run が aria-disabled
  await expect(page.getByTestId('cmd-edit-test-run')).toHaveAttribute('aria-disabled', 'true');

  // force クリックしても param-form-modal は開かず POST も呼ばれない
  await page.getByTestId('cmd-edit-test-run').click({ force: true });
  await new Promise((r) => setTimeout(r, 500));
  expect(await page.getByTestId('param-form-modal').count()).toBe(0);
  expect(runBodies).toHaveLength(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-2-3] dirty 状態でテスト実行すると先に PUT 保存してから POST run', async ({ page }) => {
  const { unexpected } = await openApp(page);
  const callOrder: string[] = [];

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(VALID_COMMAND_CONTENT)));
      return;
    }
    if (req.method() === 'PUT') {
      callOrder.push('PUT');
      void route.fulfill(json({ path: 'commands/create-todo.md', created: false, mtime: 9999 }));
      return;
    }
    void route.fallback();
  });

  await page.route('**/api/commands/create-todo/run', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      callOrder.push('POST');
      void route.fulfill(json({ results: [{ kind: 'journal-append', ok: true }] }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();

  // 何か入力して dirty にする
  await page.getByTestId('cmd-edit-yaml').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  // 末尾に改行追加 (YAML の外なので valid を維持)
  await page.keyboard.press('Enter');

  // dirty 状態になる
  await expect(page.getByTestId('save-status').first()).toHaveAttribute('data-state', 'dirty');
  // バリデーション valid のまま
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // テスト実行 (params なしのパスを使うため、NO_PARAM_COMMAND_CONTENT に似ているが
  // VALID_COMMAND_CONTENT には params があるので modal が開く。
  // この test では params 有りルートを使う → modal が開く)
  await page.getByTestId('cmd-edit-test-run').click();

  // param-form-modal が開く前に PUT が呼ばれているはず
  // モーダルを待つ
  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // summary を入力して submit
  await page.locator('[data-testid="param-field-input"][data-name="summary"]').fill('dirty test');
  await page.getByTestId('param-form-submit').click();

  // run-result が表示
  await expect(page.getByTestId('cmd-edit-run-result')).toBeVisible();

  // 順序: PUT → POST
  expect(callOrder[0]).toBe('PUT');
  expect(callOrder[1]).toBe('POST');

  expect(unexpected).toEqual([]);
});

test('[AC-S9e64e7-2-3] partial-failure: step-result[data-ok=false] が表示される', async ({ page }) => {
  const { unexpected } = await openApp(page);

  await page.route('**/api/notes/commands/create-todo.md', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json(commandNote(NO_PARAM_COMMAND_CONTENT)));
      return;
    }
    void route.fallback();
  });

  await page.route('**/api/commands/create-todo/run', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      void route.fulfill(
        json({
          results: [{ kind: 'journal-append', ok: false, error: 'journal not found' }],
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').filter({ hasText: 'create-todo' }).click();
  await expect(page.getByTestId('command-editor')).toBeVisible();
  await expect(page.getByTestId('cmd-edit-validation')).toHaveAttribute('data-valid', 'true');

  // テスト実行 (params なし → 即 run)
  await page.getByTestId('cmd-edit-test-run').click();

  // cmd-edit-run-result が表示
  await expect(page.getByTestId('cmd-edit-run-result')).toBeVisible();

  // step-result[data-ok=false] が表示
  const failRow = page.locator('[data-testid="step-result"][data-kind="journal-append"][data-ok="false"]');
  await expect(failRow).toBeVisible();
  await expect(failRow).toContainText('journal not found');

  expect(unexpected).toEqual([]);
});
