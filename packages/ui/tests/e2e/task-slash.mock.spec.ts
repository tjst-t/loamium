/**
 * Se3b7a2-7 mock テスト — スラッシュメニュー /task コマンド。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-19';
const JOURNAL_PATH = `journals/${DATE}.md`;

// アンカー行付きのシンプルなジャーナルコンテンツ
const ANCHOR_CONTENT = 'メモ。\n\nアンカー行。\n';

async function openWithAnchor(page: Parameters<typeof installCatchAll>[0]) {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({
        date: DATE,
        path: JOURNAL_PATH,
        content: ANCHOR_CONTENT,
        frontmatter: null,
        body: ANCHOR_CONTENT,
        created: false,
        mtime: 1000,
      }),
    );
  });
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fallback();
  });
  await page.goto(readHarnessState().uiUrl);
  // アンカー行が表示されるまで待つ
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  return unexpected;
}

/** アンカー行末で改行し /query を打ってスラッシュメニューを開く */
async function openSlashMenu(page: Parameters<typeof installCatchAll>[0], query: string) {
  const editorLine = page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).first();
  await editorLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(`\n/${query}`);
  await expect(page.getByTestId('slash-menu')).toBeVisible();
}

test('[MOCK][Se3b7a2-7] /task でスラッシュメニューに「タスク / TODO」が出る', async ({ page }) => {
  await openWithAnchor(page);
  await openSlashMenu(page, 'task');
  const item = page.locator('[data-testid="slash-item"][data-command="task"]');
  await expect(item).toBeVisible();
});

test('[MOCK][Se3b7a2-7] task コマンド実行で - [ ]  が挿入される', async ({ page }) => {
  await openWithAnchor(page);
  await openSlashMenu(page, 'task');
  // task アイテムが存在することを確認してからクリック実行
  const taskItem = page.locator('[data-testid="slash-item"][data-command="task"]');
  await expect(taskItem).toBeVisible({ timeout: 3000 });
  await taskItem.click();
  // - [ ]  が挿入されていること
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('- [ ]', { timeout: 3000 });
});

test('[MOCK][Se3b7a2-7] task コマンド実行後 task-quick-popover が表示され per-field ピッカーが含まれる', async ({ page }) => {
  // installCatchAll (openWithAnchor 内) が /api/settings/tasks を登録するので
  // その後で上書きが必要 — openWithAnchor の戻り値後に追加登録する
  await openWithAnchor(page);
  // task 語彙 API の応答を確保 (installCatchAll の既定がある場合もここで補強)
  await page.route('**/api/settings/tasks', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        vocab: {
          statuses: [
            { key: 'todo', label: 'Todo', color: 'gray' },
            { key: 'progress', label: 'Progress', color: 'blue' },
            { key: 'done', label: 'Done', color: 'green', done: true },
          ],
          priorities: [
            { key: 'high', label: '高', color: 'amber' },
            { key: 'medium', label: '中', color: 'blue' },
            { key: 'low', label: '低', color: 'gray' },
          ],
        },
      }),
    });
  });
  await openSlashMenu(page, 'task');
  // task アイテムをクリックして確実に実行
  const taskItem = page.locator('[data-testid="slash-item"][data-command="task"]');
  await expect(taskItem).toBeVisible({ timeout: 3000 });
  await taskItem.click();
  // per-field ピッカーポップオーバーが表示される
  await expect(page.getByTestId('task-quick-popover')).toBeVisible({ timeout: 3000 });
  // ステータスセクション (chips)
  await expect(page.getByTestId('task-popover-status')).toBeVisible();
  // 優先度セクション (chips)
  await expect(page.getByTestId('task-popover-priority')).toBeVisible();
  // 期限カレンダー
  await expect(page.getByTestId('task-due-cal')).toBeVisible();
  // 「なし」デフォルト選択
  await expect(page.getByTestId('status-opt-none')).toBeVisible();
  await expect(page.getByTestId('priority-opt-none')).toBeVisible();
  // 自然言語テキスト入力ボックスは存在しない (廃止)
  await expect(page.locator('.task-nl-hint')).toHaveCount(0);
});

test('[MOCK][Se3b7a2-7] /todo でも task コマンドが絞り込まれる', async ({ page }) => {
  await openWithAnchor(page);
  await openSlashMenu(page, 'todo');
  const item = page.locator('[data-testid="slash-item"][data-command="task"]');
  await expect(item).toBeVisible();
});
