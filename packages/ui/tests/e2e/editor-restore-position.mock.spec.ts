/**
 * エディタ位置(スクロール + カーソル)保存・復元のモックテスト。
 *
 * [要望1] ノート切替時に現在の scrollTop と カーソル head を localStorage へ保存し、
 * 同じノートを再度開いたときに復元することを検証する。
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

/** 十分な行数を持つノートA (スクロールテスト用に多めの行) */
function makeNoteAContent(): string {
  const lines: string[] = ['# ノートA'];
  for (let i = 1; i <= 60; i++) {
    lines.push(`行 ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. テキストが続きます。`);
  }
  lines.push('');
  return lines.join('\n');
}

const NOTE_A_PATH = 'notes/note-a.md';
const NOTE_B_PATH = 'notes/note-b.md';
const NOTE_A_CONTENT = makeNoteAContent();
const NOTE_B_CONTENT = '# ノートB\n\nノートBの内容です。\n';

async function bootWithTwoNotes(page: Page): Promise<{ unexpected: string[] }> {
  const unexpected = await installCatchAll(page);

  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: NOTE_A_PATH, title: 'note-a', tags: [], folder: 'notes' },
          { path: NOTE_B_PATH, title: 'note-b', tags: [], folder: 'notes' },
        ],
      }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const url = req.url();
      const isNoteA = url.includes(encodeURIComponent('note-a'));
      const content = isNoteA ? NOTE_A_CONTENT : NOTE_B_CONTENT;
      const path = isNoteA ? NOTE_A_PATH : NOTE_B_PATH;
      void route.fulfill(
        json({ path, content, frontmatter: null, body: content, mtime: 100 }),
      );
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  return { unexpected };
}

/**
 * CodeMirror の selection.main.head を取得するヘルパー
 */
async function getCursorHead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const view = (window as unknown as { __loamiumEditorView__: { state: { selection: { main: { head: number } } } } | null }).__loamiumEditorView__;
    if (view === null || view === undefined) throw new Error('EditorView not found');
    return view.state.selection.main.head;
  });
}

/**
 * scrollDOM.scrollTop を取得するヘルパー
 */
async function getScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const view = (window as unknown as { __loamiumEditorView__: { scrollDOM: { scrollTop: number } } | null }).__loamiumEditorView__;
    if (view === null || view === undefined) throw new Error('EditorView not found');
    return view.scrollDOM.scrollTop;
  });
}

/**
 * localStorage の保存内容を取得するヘルパー
 */
async function getStoredPos(
  page: Page,
  path: string,
): Promise<{ top: number; head: number } | null> {
  return page.evaluate((notePath) => {
    try {
      const raw = localStorage.getItem('loamium.editorPos.v1');
      if (raw === null) return null;
      const all = JSON.parse(raw) as Record<string, { top: number; head: number }>;
      return all[notePath] ?? null;
    } catch {
      return null;
    }
  }, path);
}

test('[MOCK][RESTORE] ノートA→B→A の切替で カーソル位置が復元される', async ({ page }) => {
  await bootWithTwoNotes(page);

  // ノートA を開く
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_A_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ノートA');

  // エディタをクリックしてカーソルを中ほどへ移動 (矢印キーで下方へ)
  const editor = page.getByTestId('editor');
  await editor.click();
  await page.keyboard.press('Control+Home');
  // 20行下へ移動
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowDown');
  }
  const headAfterMove = await getCursorHead(page);
  expect(headAfterMove).toBeGreaterThan(0);

  // ノートB へ切替 (保存が走る)
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_B_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ノートB');

  // localStorage に ノートA の位置が保存されていることを確認
  const stored = await getStoredPos(page, NOTE_A_PATH);
  expect(stored).not.toBeNull();
  expect(stored?.head).toBe(headAfterMove);

  // ノートA へ戻る
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_A_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ノートA');

  // カーソルが復元されていることを確認
  const restoredHead = await getCursorHead(page);
  expect(restoredHead).toBe(headAfterMove);
});

test('[MOCK][RESTORE] 初めて開くノートには保存位置がなく initialAnchor が使われる', async ({ page }) => {
  await bootWithTwoNotes(page);

  // localStorage をクリア
  await page.evaluate(() => {
    localStorage.removeItem('loamium.editorPos.v1');
  });

  // ノートA を開く (初回 = 保存なし)
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_A_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ノートA');

  // frontmatter なしノートは pos 0 が initialAnchor
  const head = await getCursorHead(page);
  expect(head).toBe(0);

  // localStorage にはまだ保存されていない (切替前なので)
  const stored = await getStoredPos(page, NOTE_A_PATH);
  expect(stored).toBeNull();
});

test('[MOCK][RESTORE] ノートB からノートA へ切替時に localStorage へ保存される', async ({ page }) => {
  await bootWithTwoNotes(page);

  // localStorage をクリア
  await page.evaluate(() => {
    localStorage.removeItem('loamium.editorPos.v1');
  });

  // ノートA を開く
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_A_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ノートA');

  // 15行移動
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('ArrowDown');
  }
  const savedHead = await getCursorHead(page);

  // ノートB へ切替 → ノートA の位置が保存されるべき
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_B_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('ノートB');

  // 保存を確認
  const stored = await getStoredPos(page, NOTE_A_PATH);
  expect(stored).not.toBeNull();
  expect(stored?.head).toBe(savedHead);
});
