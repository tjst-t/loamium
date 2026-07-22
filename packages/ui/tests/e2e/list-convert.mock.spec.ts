/**
 * Story S6848dc-6 mock テスト — リストタイプ一括変換 (箇条書き ⇄ 番号付き)。
 * page.route で全 /api/* をモックする。
 *
 * AC-1: Ctrl-K パレットから「箇条書きに変換」「番号付きに変換」を実行できる。
 * AC-2: Ctrl+Shift+8 (箇条書き) / Ctrl+Shift+7 (番号付き) で変換できる。
 * AC-3: 番号付きへ変換時の採番が正しい (ネスト対応)。
 * AC-4: ピュア Markdown の書き換え (- ⇄ 1.)。インデント・子項目・チェックボックスを保持。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json, type PutBody } from '../harness/mock-helpers.js';

const DATE = '2026-07-21';
const JOURNAL_PATH = `journals/${DATE}.md`;

// トップレベル + ネスト + チェックボックスを含むリスト。
const LIST_CONTENT = [
  '# リスト',
  '',
  '- 親項目',
  '    - 子項目1',
  '    - 子項目2',
  '- [ ] タスク項目',
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

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

/** 起動時モックを設置し、PUT 本文をキャプチャできる状態でエディタ表示まで進める */
async function openWithList(page: Page): Promise<{ unexpected: string[]; saved: () => string | null }> {
  const unexpected = await installCatchAll(page);
  let savedContent: string | null = null;
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(LIST_CONTENT)));
  });
  await page.route('**/api/notes/journals/**', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as PutBody;
      savedContent = body.content;
      void route.fulfill(json({ path: JOURNAL_PATH, mtime: 2000, created: false }));
      return;
    }
    void route.fulfill(json(journal(LIST_CONTENT)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('親項目');
  return { unexpected, saved: () => savedContent };
}

/** 全リスト行を含むよう本文全体を選択する (Ctrl+A) */
async function selectAll(page: Page): Promise<void> {
  await editorLine(page, '親項目').click();
  await page.keyboard.press('Control+a');
}

test('[AC-2][MOCK] Ctrl+Shift+7 で選択した箇条書きが番号付きへ変換される (ネスト採番・チェックボックス保持)', async ({ page }) => {
  const { unexpected, saved } = await openWithList(page);

  await selectAll(page);
  await page.keyboard.press('Control+Shift+Digit7');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  const content = saved();
  expect(content).not.toBeNull();
  // トップレベル 1,2 / ネスト子は 1 から採番 / チェックボックスはコンテンツとして保持
  expect(content).toContain('1. 親項目');
  expect(content).toContain('    1. 子項目1');
  expect(content).toContain('    2. 子項目2');
  expect(content).toContain('2. [ ] タスク項目');
  // 見出し・空行は不変
  expect(content).toContain('# リスト');
  expect(unexpected).toEqual([]);
});

test('[AC-2][MOCK] Ctrl+Shift+8 で番号付きが箇条書きへ戻る (round-trip)', async ({ page }) => {
  const { unexpected, saved } = await openWithList(page);

  await selectAll(page);
  // まず番号付きへ
  await page.keyboard.press('Control+Shift+Digit7');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  // 続けて箇条書きへ戻す
  await selectAll(page);
  await page.keyboard.press('Control+Shift+Digit8');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  const content = saved();
  expect(content).not.toBeNull();
  expect(content).toContain('- 親項目');
  expect(content).toContain('    - 子項目1');
  expect(content).toContain('- [ ] タスク項目'); // チェックボックス復帰
  expect(content).not.toContain('1. '); // 番号は残っていない
  expect(unexpected).toEqual([]);
});

test('[AC-1][MOCK] Ctrl-K パレットの「リストを番号付きに変換」で選択リストが変換される', async ({ page }) => {
  const { unexpected, saved } = await openWithList(page);

  // カーソルを親項目行に置く (単一行カーソル → リストブロック全体が対象)
  await selectAll(page);

  // Ctrl-K でパレットを開き、コマンドを絞り込んで実行する
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('search-input').type('番号付き');
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="convert-list-to-ordered"]'),
  ).toBeVisible();
  await page.locator('[data-testid="command-item"][data-command-id="convert-list-to-ordered"]').click();

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  const content = saved();
  expect(content).not.toBeNull();
  expect(content).toContain('1. 親項目');
  expect(content).toContain('    1. 子項目1');
  expect(unexpected).toEqual([]);
});

test('[AC-1][MOCK] パレットの「リストを箇条書きに変換」コマンドが表示される', async ({ page }) => {
  const { unexpected } = await openWithList(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('search-input').type('箇条書き');
  await expect(
    page.locator('[data-testid="command-item"][data-command-id="convert-list-to-bullet"]'),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
});
