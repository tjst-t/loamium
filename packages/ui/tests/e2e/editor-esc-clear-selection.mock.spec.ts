/**
 * エディタ ESC キーによる選択解除のモックテスト。
 *
 * [要望2] 複数行テキスト選択がある状態で ESC を押すと、
 * 選択がキャレット(空選択)へ畳まれることを検証する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY_JOURNAL = {
  date: '2026-07-24',
  path: 'journals/2026/07/2026-07-24.md',
  content: '',
  frontmatter: null,
  body: '',
  created: false,
  mtime: 1000,
};

const NOTE_PATH = 'notes/esc-test.md';
const NOTE_CONTENT = [
  '# ESC テスト',
  '',
  '1行目のテキストです。',
  '2行目のテキストです。',
  '3行目のテキストです。',
  '',
  '- [ ] タスクチェックボックス',
  '',
].join('\n');

async function bootWithNote(page: Page): Promise<void> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [{ path: NOTE_PATH, title: 'esc-test', tags: [], folder: 'notes' }],
      }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({
          path: NOTE_PATH,
          content: NOTE_CONTENT,
          frontmatter: null,
          body: NOTE_CONTENT,
          mtime: 100,
        }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  // ノートをツリーからクリックして開く
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ESC テスト');

  // 予期しない呼び出しがないことは後から確認するため保存
  (page as unknown as { _unexpected: string[] })._unexpected = unexpected;
}

/**
 * CodeMirror の selection.main を取得するヘルパー
 */
async function getSelection(
  page: Page,
): Promise<{ anchor: number; head: number; empty: boolean }> {
  return page.evaluate(() => {
    const view = (window as unknown as { __loamiumEditorView__: { state: { selection: { main: { anchor: number; head: number; empty: boolean } } } } | null }).__loamiumEditorView__;
    if (view === null || view === undefined) throw new Error('EditorView not found');
    const main = view.state.selection.main;
    return { anchor: main.anchor, head: main.head, empty: main.empty };
  });
}

test('[MOCK][ESC] 複数行テキスト選択があるとき ESC で選択を解除してキャレットになる', async ({ page }) => {
  await bootWithNote(page);

  const editor = page.getByTestId('editor');
  await editor.click();

  // 1行目の先頭へ移動してから Shift+ArrowDown で複数行選択
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');

  // 選択が非空であることを確認
  const selBefore = await getSelection(page);
  expect(selBefore.empty).toBe(false);
  expect(selBefore.anchor).not.toBe(selBefore.head);

  // ESC で選択解除
  await page.keyboard.press('Escape');

  // 選択が空(キャレット)になることを確認
  const selAfter = await getSelection(page);
  expect(selAfter.empty).toBe(true);
  expect(selAfter.anchor).toBe(selAfter.head);
  // head の位置はそのまま保持される (anchor が head へ移動)
  expect(selAfter.head).toBe(selBefore.head);
});

test('[MOCK][ESC] 選択がないとき ESC は false を返し他の挙動を妨げない', async ({ page }) => {
  await bootWithNote(page);

  const editor = page.getByTestId('editor');
  await editor.click();

  // キャレットのみ (選択なし)
  await page.keyboard.press('Control+Home');
  const selBefore = await getSelection(page);
  expect(selBefore.empty).toBe(true);

  // ESC を押してもキャレット状態が変わらない (エラーが起きない)
  await page.keyboard.press('Escape');
  const selAfter = await getSelection(page);
  expect(selAfter.empty).toBe(true);
  expect(selAfter.head).toBe(selBefore.head);
});

test('[MOCK][ESC] Shift+End で1行内選択も ESC で解除できる', async ({ page }) => {
  await bootWithNote(page);

  const editor = page.getByTestId('editor');
  await editor.click();

  // 1行目の先頭へ移動
  await page.keyboard.press('Control+Home');
  // ArrowDown で2行目へ (空行)、さらに ArrowDown で3行目(1行目のテキスト)
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  // Shift+End で行末まで選択
  await page.keyboard.press('Shift+End');

  const selBefore = await getSelection(page);
  expect(selBefore.empty).toBe(false);

  // ESC で選択解除
  await page.keyboard.press('Escape');

  const selAfter = await getSelection(page);
  expect(selAfter.empty).toBe(true);
  expect(selAfter.head).toBe(selBefore.head);
});
