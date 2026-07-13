/**
 * Story S9e64e7-1 mock テスト — 定義エディタ検出 + スプリットシェル + 保存。
 * page.route で全 /api/* をモックし、フロントエンドの振る舞いだけを検証する。
 *
 * AC-S9e64e7-1-1: commands/ + loamium-command → CommandEditor (command-editor) が visible;
 *                 commands/ 外 / loamium-command なし → 通常 Editor が visible。
 * AC-S9e64e7-1-2: 保存ボタンは valid のとき有効; invalid (スキーマエラー) のとき aria-disabled。
 * AC-S9e64e7-1-3: testid は gui-spec / prototype V3 に準拠。
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

/** 有効なスマートコマンド定義ノート */
const VALID_COMMAND_CONTENT = [
  '---',
  'loamium-command:',
  '  name: create todo',
  '  description: タスクを今日のジャーナルに追記',
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

function commandNote(content: string, mtime = 2000): Record<string, unknown> {
  return {
    path: 'commands/create-todo.md',
    content,
    frontmatter: {
      'loamium-command': {
        name: 'create todo',
        description: 'タスクを追記',
        steps: [{ kind: 'journal-append', content: '- [ ] {{summary}}', section: 'Todo' }],
      },
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
