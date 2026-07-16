/**
 * Story Sde7a63-3 E2E テスト — スマートコマンド実行フロー (実サーバー)。
 *
 * globalSetup が起動した実サーバー + Vite dev server に対して受け入れ条件を検証する。
 * テスト vault に commands/create-todo.md をシードし、パレットから完全なフローを確認する。
 *
 * [AC-Sde7a63-3-4] create todo の一連フロー:
 *   Ctrl-K → '>' 絞り込み → フォーム入力 → 実行 → ジャーナルの Todo セクションに追記反映
 */
import { test, expect } from '@playwright/test';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

/**
 * コマンドファイルの name は "create todo" (スペース入り、ファイル stem "create-todo" と異なる)。
 * これにより UI が id (stem) を使って run を呼ぶことが必要になる — 表示名で呼ぶと 404 になる。
 * [BUG-REGRESSION] このフィクスチャが id/stem に基づく実行フローのロックイン。
 * ADR-0024: .yaml ファイル全体 = LoamiumCommand オブジェクト
 */
const CREATE_TODO_COMMAND = [
  'name: create todo',
  'description: 今日のジャーナル Todo セクションにタスクを追加する',
  'params:',
  '  - name: タスク概要',
  '    type: string',
  '    required: true',
  '    label: タスク概要',
  '  - name: 期限',
  '    type: date',
  '    required: false',
  '    label: 期限',
  'steps:',
  '  - kind: journal-append',
  '    section: Todo',
  '    content: "- [ ] {{タスク概要}}"',
  '    open: true',
].join('\n');

test.beforeAll(async () => {
  const { vault } = readHarnessState();
  // 共有 vault 対策: command-editor.e2e が create-todo を保存すると system/commands/ へ
  // 昇格し、コマンド解決が system/commands/ を優先して commands/ を shadowing する
  // (params が seed 定義=summary に化ける)。この spec の fixture を authoritative にするため
  // 昇格分を掃除してから commands/ に書く (実行順に依存しない)。
  await rm(path.join(vault, 'system', 'commands', 'create-todo.yaml'), { force: true });
  const commandsDir = path.join(vault, 'commands');
  await mkdir(commandsDir, { recursive: true });
  await writeFile(path.join(commandsDir, 'create-todo.yaml'), CREATE_TODO_COMMAND, 'utf8');
});

test.beforeEach(async ({ page }) => {
  await page.goto(readHarnessState().uiUrl);
  // エディタが表示されるまで待つ (ジャーナルが開いている状態)
  await expect(page.locator('[data-testid="editor"]')).toBeVisible({ timeout: 15_000 });
});

// =========================================================================
// AC-Sde7a63-3-4: create-todo コマンドの完全 E2E フロー
// =========================================================================

test('[AC-Sde7a63-3-4][E2E] Ctrl-K → > todo → フォーム入力 → 実行 → ジャーナル Todo セクションに追記', async ({ page }) => {
  // 1. Ctrl-K でパレットを開く
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // 2. '> todo' でコマンドモードへ + フィルタ
  await page.getByTestId('search-input').fill('> todo');
  await expect(page.getByTestId('palette-mode-command')).toBeVisible();

  // 3. create-todo コマンドが表示される
  const createTodoItem = page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]');
  await expect(createTodoItem).toBeVisible({ timeout: 5_000 });

  // 4. create-todo を選択
  await createTodoItem.click();

  // 5. パラメータフォームモーダルが開く (表示名 "create todo" が表示される)
  await expect(page.getByTestId('param-form-modal')).toBeVisible();
  await expect(page.getByTestId('param-form-title')).toContainText('create todo');

  // 6. タスク概要フィールドに入力 (E2E 識別子として一意な文字列)
  const taskSummary = '新機能実装チェック';
  const summaryInput = page.locator('[data-testid="param-field-input"][data-name="タスク概要"]');
  await expect(summaryInput).toBeVisible();
  await summaryInput.fill(taskSummary);

  // 7. 実行ボタンをクリック (required が満たされたので aria-disabled は false のはず)
  const submitBtn = page.getByTestId('param-form-submit');
  await expect(submitBtn).not.toHaveAttribute('aria-disabled', 'true');
  await submitBtn.click();

  // 8. 成功時: パレットとフォームが閉じる
  await expect(page.getByTestId('param-form-modal')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  // 9. ジャーナルノートが開いている (journals/ パスが URL / route に反映される)
  await expect(page.getByTestId('route-display')).toContainText('journals');

  // 10. エディタにタスクが追記されている
  // CodeMirror は "- [ ]" をタスクリストウィジェット(チェックボックスボタン)に変換するため、
  // .cm-line セレクタで rawソース行を探す。タスクサマリーが含まれる行が存在すれば OK。
  await expect(
    page.locator('[data-testid="editor"] .cm-line', { hasText: taskSummary }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // 11. ジャーナルのRawファイルを読み込んで Todo セクション検証 (section insertion の核心)
  // GET /api/journal でファイルパスを取得し、vault 上のファイルを直接読む。
  const { vault, apiUrl } = readHarnessState();
  const journalRes = await fetch(`${apiUrl}/api/journal`);
  expect(journalRes.ok).toBe(true);
  const journalData = await journalRes.json() as { path: string; body: string };
  const rawMarkdown = await readFile(path.join(vault, journalData.path), 'utf8');

  // "## Todo" ヘッダーが存在し、その直後のセクション内に "- [ ] <taskSummary>" 行が含まれる
  const lines = rawMarkdown.split('\n');
  const todoHeadingIdx = lines.findIndex((l) => l.trim() === '## Todo');
  expect(todoHeadingIdx, '## Todo heading must exist in journal').toBeGreaterThanOrEqual(0);

  // Todo セクション: todoHeadingIdx+1 から次の heading (## / #) までの行
  const sectionLines: string[] = [];
  for (let i = todoHeadingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^#{1,6}\s/.test(line)) break; // 次の heading で終わり
    if (line !== undefined) sectionLines.push(line);
  }

  const todoLine = `- [ ] ${taskSummary}`;
  expect(
    sectionLines.some((l) => l.includes(todoLine)),
    `Expected "${todoLine}" inside ## Todo section.\nSection lines: ${JSON.stringify(sectionLines)}`,
  ).toBe(true);
});

// =========================================================================
// AC-Sde7a63-3-1: create-todo が source=smart で表示される (実サーバー)
// =========================================================================

test('[AC-Sde7a63-3-1][E2E] create-todo コマンドがパレットに source=smart で表示される', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // smart コマンドが表示されるまで待つ (非同期取得)
  const smartItem = page.locator('[data-testid="command-item"][data-source="smart"][data-command-id="smart:create-todo"]');
  await expect(smartItem).toBeVisible({ timeout: 5_000 });
});

// =========================================================================
// AC-Sde7a63-3-2: パラメータフォームが正しく表示される (実サーバー)
// =========================================================================

test('[AC-Sde7a63-3-2][E2E] create-todo 選択でフォームが開きフィールドが揃う', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const smartItem = page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]');
  await expect(smartItem).toBeVisible({ timeout: 5_000 });
  await smartItem.click();

  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // タスク概要フィールド
  await expect(
    page.locator('[data-testid="param-field"][data-name="タスク概要"][data-required="true"]'),
  ).toBeVisible();

  // 期限フィールド (date)
  await expect(
    page.locator('[data-testid="param-field"][data-name="期限"][data-type="date"]'),
  ).toBeVisible();

  // パレットが引き続き visible
  await expect(page.getByTestId('command-palette')).toBeVisible();
});

// =========================================================================
// AC-Sde7a63-3-?: Esc でフォームを閉じてパレットへ戻る (実サーバー)
// =========================================================================

test('[AC-Sde7a63-3][E2E] フォームで Esc → フォームが閉じてパレットへ戻る', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const smartItem = page.locator('[data-testid="command-item"][data-command-id="smart:create-todo"]');
  await expect(smartItem).toBeVisible({ timeout: 5_000 });
  await smartItem.click();

  await expect(page.getByTestId('param-form-modal')).toBeVisible();

  // Esc でフォームを閉じる
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('param-form-modal')).toHaveCount(0);

  // パレットは引き続き表示
  await expect(page.getByTestId('command-palette')).toBeVisible();
});
