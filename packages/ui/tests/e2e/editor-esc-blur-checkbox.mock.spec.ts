/**
 * エディタ ESC キーによる blur(どの行もアクティブでない状態)のモックテスト。
 *
 * [要望2] タスク行にカーソルを置くとその行はソース表示 (`- [ ]`) になり、
 * チェックボックス widget が描画されずクリックでトグルできない。
 * ESC を押すとエディタが blur してアクティブ行が無くなり、全行が widget 表示に戻って
 * チェックボックスをクリック→トグルできることを検証する。
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
  '本文の段落テキスト。',
  '',
  '- [ ] タスクチェックボックス',
  '',
].join('\n');

async function bootWithNote(page: Page): Promise<void> {
  await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: NOTE_PATH, title: 'esc-test', tags: [], folder: 'notes' }] }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({ path: NOTE_PATH, content: NOTE_CONTENT, frontmatter: null, body: NOTE_CONTENT, mtime: 100 }),
      );
      return;
    }
    // PUT (autosave 等) は成功で受ける
    if (req.method() === 'PUT') {
      void route.fulfill(json({ path: NOTE_PATH, created: false, mtime: 101 }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ESC テスト');
}

/** doc テキストを取得 */
async function docText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = (window as unknown as { __loamiumEditorView__: { state: { doc: { toString(): string } } } | null }).__loamiumEditorView__;
    if (view === null || view === undefined) throw new Error('EditorView not found');
    return view.state.doc.toString();
  });
}

test('[MOCK][ESC] タスク行にカーソルがあると widget が出ず、ESC で blur すると widget が出てクリックでトグルできる', async ({ page }) => {
  await bootWithNote(page);
  const editor = page.getByTestId('editor');
  const checkbox = editor.locator('[data-testid="task-checkbox"]');

  // 初期: カーソルはタスク行に無い → チェックボックス widget が描画されている
  await expect(checkbox).toHaveCount(1);

  // タスク行の本文テキストをクリックしてカーソルをその行に置く (widget ではなくテキスト部分)
  await editor.locator('.cm-line', { hasText: 'タスクチェックボックス' }).click();
  // アクティブ行はソース表示になり widget が消える。エディタは focus 状態。
  await expect(checkbox).toHaveCount(0);
  const isFocused = () => page.evaluate(() => document.querySelector('.cm-editor')?.classList.contains('cm-focused') ?? false);
  await expect.poll(isFocused).toBe(true);

  // ESC → blur
  await page.keyboard.press('Escape');

  // エディタが blur し、どの行もアクティブでない → widget が再び出る
  await expect.poll(isFocused).toBe(false);
  await expect(checkbox).toHaveCount(1);

  // チェックボックスをクリック → タスクがトグルされる ([ ] → [x])
  await checkbox.click();
  await expect.poll(() => docText(page)).toContain('- [x] タスクチェックボックス');
});

test('[MOCK][ESC] ESC でエディタが blur する (アクティブ行ハイライトが消える)', async ({ page }) => {
  await bootWithNote(page);
  const editor = page.getByTestId('editor');

  const isFocused = () => page.evaluate(() => document.querySelector('.cm-editor')?.classList.contains('cm-focused') ?? false);
  await editor.locator('.cm-line', { hasText: '本文の段落テキスト' }).click();
  await expect.poll(isFocused).toBe(true);

  await page.keyboard.press('Escape');
  await expect.poll(isFocused).toBe(false);
});
