/**
 * Se3b7a2-4/5 mock テスト — Dataview TASK ツリー + インライン編集。
 * page.route で全 /api/* をモックする。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-19';
const JOURNAL_PATH = `journals/${DATE}.md`;

const FENCE_CONTENT = [
  '```dataview',
  'TASK WHERE !checked',
  '```',
  '',
  'アンカー行。',
  '',
].join('\n');

const TASK_RESULTS = {
  type: 'task',
  results: [
    // 親タスク: status/priority/due あり
    {
      path: 'projects/test.md',
      title: 'テスト',
      line: 3,
      text: '親タスク1',
      checked: false,
      indent: 0,
      status: 'progress',
      priority: 'high',
      due: '2099-12-31',
    },
    // 子タスク: シンプル (フィールドなし)
    {
      path: 'projects/test.md',
      title: 'テスト',
      line: 4,
      text: '子タスク1',
      checked: false,
      indent: 2,
      status: null,
      priority: null,
      due: null,
    },
    // 親タスク: シンプル (フィールドなし)
    {
      path: 'projects/test.md',
      title: 'テスト',
      line: 5,
      text: '親タスク2 シンプル',
      checked: true,
      indent: 0,
      status: null,
      priority: null,
      due: null,
    },
  ],
};

async function openWithTaskFence(page: Parameters<typeof installCatchAll>[0]) {
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
        content: FENCE_CONTENT,
        frontmatter: null,
        body: FENCE_CONTENT,
        created: false,
        mtime: 1000,
      }),
    );
  });
  await page.goto(readHarnessState().uiUrl);
  // カーソルがフェンス外に移るまで待ち、query ルートを登録してからアンカー行をクリック。
  // これにより fence が widget モードに切り替わり /api/query が呼ばれる。
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  await page.route('**/api/query', (route) => {
    void route.fulfill(json(TASK_RESULTS));
  });
  // アンカー行をクリックしてフェンスをレンダリング状態にする
  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).first().click();
  return unexpected;
}

test('[MOCK][Se3b7a2-4] TASK クエリ結果が dv-task として描画される', async ({ page }) => {
  await openWithTaskFence(page);
  // fence がレンダリングされるまで待つ
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  const tasks = page.getByTestId('dv-task');
  await expect(tasks).toHaveCount(2); // 親タスク2件 (子は dv-task-child)
});

test('[MOCK][Se3b7a2-4] 子タスク付き親行はデフォルト折りたたみ (dv-task-children[data-expanded=false])', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  const children = page.getByTestId('dv-task-children');
  await expect(children.first()).toHaveAttribute('data-expanded', 'false');
});

test('[MOCK][Se3b7a2-4] dv-task-expand クリックで子コンテナが展開される', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  const expandBtn = page.getByTestId('dv-task-expand').first();
  await expandBtn.click();
  const children = page.getByTestId('dv-task-children').first();
  await expect(children).toHaveAttribute('data-expanded', 'true');
  await expect(page.getByTestId('dv-task-child')).toBeVisible();
});

test('[MOCK][Se3b7a2-4] チェックボックス列縦整列: dv-toggle-slot が子なし行にも存在する', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  // 子なし行 (親タスク2) にも toggle-slot がある
  const slots = page.getByTestId('dv-toggle-slot');
  await expect(slots).toHaveCount(2);
});

test('[MOCK][Se3b7a2-4] status/priority/due ピルはフィールドありの行にのみ表示される', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  // status pill: progress → status-pill[data-status=progress]
  const pills = page.locator('[data-testid="status-pill"][data-status="progress"]');
  await expect(pills).toHaveCount(1);
  // 子タスク (フィールドなし) には pill なし
  await page.getByTestId('dv-task-expand').first().click();
  const childEl = page.getByTestId('dv-task-child').first();
  await expect(childEl.getByTestId('status-pill')).toHaveCount(0);
});

test('[MOCK][Se3b7a2-4] 丸チェックボックス (task-checkbox) は data-done 属性を持つ', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  const cbs = page.getByTestId('task-checkbox');
  // 3件: 親1, 子1 (展開前は非表示), 親2
  // まず親タスク1のチェックボックスを確認
  const firstCb = cbs.first();
  await expect(firstCb).toHaveAttribute('data-done', 'false');
});

test('[MOCK][Se3b7a2-5] チェックボックスクリックで patchNote が呼ばれる', async ({ page }) => {
  const unexpected = await openWithTaskFence(page);
  const patchCalls: string[] = [];
  await page.route('**/api/notes/**/patch', (route) => {
    patchCalls.push(route.request().url());
    void route.fulfill(json({ ok: true, path: 'projects/test.md', mtime: 2000 }));
  });
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  const cb = page.getByTestId('task-checkbox').first();
  await cb.click();
  await expect.poll(() => patchCalls.length, { timeout: 3000 }).toBeGreaterThan(0);
  void unexpected;
});

test('[MOCK][Se3b7a2-5] dv-task-edit ボタンが存在する (各タスク行)', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  // 親2件 + 子1件 (collapsed だが DOM 上には存在) = 計 3件
  const editBtns = page.getByTestId('dv-task-edit');
  await expect(editBtns).toHaveCount(3);
  // 親タスク行の edit ボタンは visible
  await expect(editBtns.first()).toBeVisible();
});

test('[MOCK][Se3b7a2-5] dv-task-edit クリックでポップオーバーが開く', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  const editBtn = page.getByTestId('dv-task-edit').first();
  await editBtn.click();
  await expect(page.getByTestId('dv-task-popover')).toBeVisible();
  await expect(page.getByTestId('dv-task-popover-cancel')).toBeVisible();
  await expect(page.getByTestId('dv-task-popover-apply')).toBeVisible();
});

test('[MOCK][Se3b7a2-5] ポップオーバーキャンセルで閉じる', async ({ page }) => {
  await openWithTaskFence(page);
  await page.locator('[data-testid="dataview-widget"][data-query-type="task"]').waitFor({ timeout: 8000 });
  await page.getByTestId('dv-task-edit').first().click();
  const pop = page.getByTestId('dv-task-popover');
  await expect(pop).toBeVisible();
  await page.getByTestId('dv-task-popover-cancel').click();
  await expect(pop).not.toBeVisible();
});
