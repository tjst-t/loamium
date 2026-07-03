/**
 * Story S9ab6c3-1 mock テスト (アウトライン操作のエッジケース・エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-S9ab6c3-1.json 参照)。
 * 受け入れ条件の本検証は outline.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json, type PutBody } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

const LIST_CONTENT = [
  '# 見出し行',
  '',
  '段落テキストです。',
  '',
  '- 親タスク',
  '    - 子タスク',
  '- [ ] 未完了タスク',
  '',
].join('\n');

function journal(content: string, mtime = 1000): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime,
  };
}

/** CodeMirror の指定テキストを含む行をクリックしてカーソルを置く */
function editorLine(page: import('@playwright/test').Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

/** 起動時モック (journal にリスト内容を返す) を設置し、エディタ表示まで進める */
async function openWithListJournal(page: import('@playwright/test').Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(LIST_CONTENT)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('親タスク');
  return unexpected;
}

test('[MOCK] 見出し・段落で Tab、トップレベルのリスト行で Shift+Tab はドキュメントを変えない', async ({ page }) => {
  const unexpected = await openWithListJournal(page);

  // 見出し行にカーソル → Tab (インデント操作にならない = dirty にならない)
  await editorLine(page, '見出し行').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 段落行にカーソル → Tab
  await editorLine(page, '段落テキストです。').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // インデント 0 のリスト行で Shift+Tab → no-op
  await editorLine(page, '親タスク').click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 直前に兄弟項目がないリスト先頭行の Tab → no-op
  // (字下げすると CommonMark でコードブロック化しピュア Markdown を壊すため)
  await editorLine(page, '親タスク').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // PUT (保存) が一度も飛んでいない = ドキュメント不変
  expect(unexpected).toEqual([]);
});

test('[MOCK] タスク行 (- [ ]) の Tab はサブツリーごとインデントし PUT 本文に反映される', async ({ page }) => {
  const unexpected = await openWithListJournal(page);

  let savedContent: string | null = null;
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as PutBody;
      savedContent = body.content;
      void route.fulfill(json({ path: JOURNAL_PATH, mtime: 2000, created: false }));
      return;
    }
    void route.fulfill(json(journal(LIST_CONTENT)));
  });

  await editorLine(page, '未完了タスク').click();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  expect(savedContent).not.toBeNull();
  expect(savedContent).toContain('    - [ ] 未完了タスク'); // 4 スペースインデント
  expect(savedContent).toContain('- 親タスク\n    - 子タスク'); // 他の行は不変
  expect(unexpected).toEqual([]);
});

test('[MOCK] チェックボックストグル後の保存が 500 で失敗したら app-error を表示し dirty のまま (編集は失われない)', async ({ page }) => {
  const unexpected = await openWithListJournal(page);

  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ error: 'io_error', message: 'disk write failed' }, 500));
      return;
    }
    void route.fulfill(json(journal(LIST_CONTENT)));
  });

  // チェックボックスをクリック ([ ] → [x])
  await page.getByTestId('task-checkbox').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');

  // 保存失敗 → エラー表示 + dirty 維持 + 編集内容 (チェック済み) はエディタに残る
  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await expect(page.getByTestId('task-checkbox')).toHaveClass(/checked/);
  expect(unexpected).toEqual([]);
});

test('[MOCK] fold-toggle は子を持つリスト行だけに出る', async ({ page }) => {
  const unexpected = await openWithListJournal(page);

  // 行 5 (- 親タスク) には子があるので fold-toggle が出る
  await expect(page.locator('[data-testid="fold-toggle"][data-line="5"]')).toBeVisible();
  // 行 6 (子タスク: 子なし) と行 7 (- [ ]: 子なし) には出ない
  await expect(page.locator('[data-testid="fold-toggle"][data-line="6"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="fold-toggle"][data-line="7"]')).toHaveCount(0);
  // 見出し行 (1) にも出ない
  await expect(page.locator('[data-testid="fold-toggle"][data-line="1"]')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
