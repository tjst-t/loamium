/**
 * Se3b7a2-2 mock テスト — エディタ チェックボックス: 丸スタイル / ピル / トリガー / ポップオーバー。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-19';
const JOURNAL_PATH = `journals/${DATE}.md`;

/** タスク行を含む journal コンテンツ (アンカー行付き) */
function makeJournal(taskLine: string) {
  const content = `${taskLine}\n\nアンカー行。\n`;
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

async function openWithTaskLine(
  page: Parameters<typeof installCatchAll>[0],
  taskLine: string,
) {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(makeJournal(taskLine)));
  });
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fallback();
  });
  await page.goto(readHarnessState().uiUrl);
  // アンカー行が表示されるまで待機
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  return unexpected;
}

/** アンカー行をクリックしてカーソルをタスク行から外す */
async function clickAnchorLine(page: Parameters<typeof installCatchAll>[0]) {
  const anchor = page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).first();
  await anchor.click();
}

test('[MOCK][Se3b7a2-2] task-checkbox に data-done 属性がある (未完了は false)', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクA');
  await clickAnchorLine(page);
  const cb = page.getByTestId('task-checkbox').first();
  await expect(cb).toBeVisible({ timeout: 3000 });
  await expect(cb).toHaveAttribute('data-done', 'false');
});

test('[MOCK][Se3b7a2-2] 完了タスクの task-checkbox は data-done=true かつ checked クラスあり', async ({ page }) => {
  await openWithTaskLine(page, '- [x] 完了タスク');
  await clickAnchorLine(page);
  const cb = page.getByTestId('task-checkbox').first();
  await expect(cb).toBeVisible({ timeout: 3000 });
  await expect(cb).toHaveAttribute('data-done', 'true');
  await expect(cb).toHaveClass(/checked/);
});

test('[MOCK][Se3b7a2-2] status インラインフィールドがあれば status-pill が表示される', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクB [status:: progress]');
  await clickAnchorLine(page);
  const pill = page.locator('[data-testid="status-pill"][data-status="progress"]');
  await expect(pill).toBeVisible({ timeout: 3000 });
});

test('[MOCK][Se3b7a2-2] シンプルタスク (フィールドなし) には status-pill が出ない', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] シンプルタスク');
  await clickAnchorLine(page);
  // task-checkbox が存在することを確認してから pill がないことを確認
  await page.getByTestId('task-checkbox').first().waitFor({ timeout: 3000 });
  const pills = page.getByTestId('status-pill');
  await expect(pills).toHaveCount(0);
});

test('[MOCK][Se3b7a2-2] checkbox-fields-trigger ボタンが存在する', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクC [status:: todo]');
  await clickAnchorLine(page);
  const trigger = page.getByTestId('checkbox-fields-trigger').first();
  await expect(trigger).toBeAttached({ timeout: 3000 });
});

test('[MOCK][Se3b7a2-2] checkbox-fields-trigger クリックでポップオーバーが開く', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクD [status:: todo]');
  await page.route('**/api/settings/tasks', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({
        vocab: {
          statuses: [
            { key: 'todo', label: 'TODO', color: '#64748b' },
            { key: 'done', label: '完了', color: '#16a34a', done: true },
          ],
          priorities: [{ key: 'high', label: '高', color: '#ea580c' }],
        },
      }));
    } else {
      void route.fallback();
    }
  });
  await clickAnchorLine(page);
  const trigger = page.getByTestId('checkbox-fields-trigger').first();
  await trigger.waitFor({ timeout: 3000 });
  await trigger.click({ force: true });
  await expect(page.getByTestId('checkbox-fields-popover')).toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('checkbox-fields-cancel')).toBeVisible();
  await expect(page.getByTestId('checkbox-fields-apply')).toBeVisible();
});

test('[MOCK][Se3b7a2-2] ポップオーバーにステータスオプションが存在する', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクE [status:: todo]');
  await clickAnchorLine(page);
  const trigger = page.getByTestId('checkbox-fields-trigger').first();
  await trigger.waitFor({ timeout: 3000 });
  await trigger.click({ force: true });
  const pop = page.getByTestId('checkbox-fields-popover');
  await expect(pop).toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('status-opt-none')).toBeVisible();
  await expect(page.getByTestId('status-opt-todo')).toBeVisible();
});

test('[MOCK][Se3b7a2-2] ポップオーバーキャンセルで閉じる', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクF');
  await clickAnchorLine(page);
  const trigger = page.getByTestId('checkbox-fields-trigger').first();
  await trigger.waitFor({ timeout: 3000 });
  await trigger.click({ force: true });
  const pop = page.getByTestId('checkbox-fields-popover');
  await expect(pop).toBeVisible({ timeout: 3000 });
  // キャンセルボタンは fixed 配置のポップオーバー内にあり viewport 外になる場合がある
  await page.getByTestId('checkbox-fields-cancel').dispatchEvent('click');
  await expect(pop).not.toBeVisible({ timeout: 2000 });
});

// ---- Bug fix: due chip に関する二重表示バグの回帰テスト ----

test('[MOCK][Se3b7a2-2][Bug1] 非アクティブ行では due-chip のみ表示され [due:: が見えない', async ({ page }) => {
  const taskLine = '- [ ] 予定タスク [due:: 2026-07-20]';
  await openWithTaskLine(page, taskLine);
  await clickAnchorLine(page); // カーソルをタスク行から外す

  // due-chip が表示されること
  const chip = page.getByTestId('due-chip');
  await expect(chip).toBeVisible({ timeout: 3000 });
  await expect(chip).toHaveAttribute('data-testid', 'due-chip');

  // ライン全体のテキストに "[due::" が含まれていないこと (REPLACE で隠されている)
  // CodeMirror のレンダリング: ウィジェットで置換されたテキストはDOMに現れない
  const editorContent = await page.getByTestId('editor').textContent();
  expect(editorContent ?? '').not.toContain('[due::');
});

test('[MOCK][Se3b7a2-2][Bug1] 非アクティブ行では status-pill のみ表示され [status:: が見えない', async ({ page }) => {
  const taskLine = '- [ ] ステータスタスク [status:: progress]';
  await openWithTaskLine(page, taskLine);
  await clickAnchorLine(page);

  const pill = page.locator('[data-testid="status-pill"]');
  await expect(pill).toBeVisible({ timeout: 3000 });

  // [status:: のソーステキストが隠されていること
  const editorContent = await page.getByTestId('editor').textContent();
  expect(editorContent ?? '').not.toContain('[status::');
});

test('[MOCK][Se3b7a2-2][Bug1] カーソル行ではソースが見えチップが非表示になる', async ({ page }) => {
  const taskLine = '- [ ] 予定タスク [due:: 2026-07-20]';
  await openWithTaskLine(page, taskLine);

  // タスク行にカーソルをおく (最初はタスク行が1行目なのでそこをクリック)
  const taskLineEl = page.locator('[data-testid="editor"] .cm-line').first();
  await taskLineEl.click();

  // カーソル行なので due-chip は非表示 (ソース表示モード)
  await expect(page.getByTestId('due-chip')).toHaveCount(0);

  // ソーステキスト [due:: が見えること
  const editorContent = await page.getByTestId('editor').textContent();
  expect(editorContent ?? '').toContain('[due::');
});

// ---- Bug fix 2a: ポップオーバー内クリックでポップオーバーが閉じないこと ----

test('[MOCK][Se3b7a2-2][Bug2a] ポップオーバー内の日付プリセットクリックでポップオーバーが閉じない', async ({ page }) => {
  await openWithTaskLine(page, '- [ ] タスクG');
  await page.route('**/api/settings/tasks', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill(json({
        vocab: {
          statuses: [{ key: 'todo', label: 'TODO', color: '#64748b' }],
          priorities: [{ key: 'high', label: '高', color: '#ea580c' }],
        },
      }));
    } else {
      void route.fallback();
    }
  });
  await clickAnchorLine(page);
  const trigger = page.getByTestId('checkbox-fields-trigger').first();
  await trigger.waitFor({ timeout: 3000 });
  await trigger.click({ force: true });
  const pop = page.getByTestId('checkbox-fields-popover');
  await expect(pop).toBeVisible({ timeout: 3000 });

  // ポップオーバー内の期限プリセット「今日」をクリック — ポップオーバーが閉じないこと
  await page.getByTestId('due-preset-today').dispatchEvent('click');
  await expect(pop).toBeVisible({ timeout: 1000 });

  // さらに「明日」をクリックしても閉じない
  await page.getByTestId('due-preset-tomorrow').dispatchEvent('click');
  await expect(pop).toBeVisible({ timeout: 1000 });
});
