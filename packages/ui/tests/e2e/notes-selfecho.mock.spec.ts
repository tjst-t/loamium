/**
 * S6848dc review fix #2 mock テスト — SSE 自己エコー再読込のカーソル飛び抑制。
 *
 * 実機バグ: ある行で文字を入力し数秒後、autosave の自己エコー
 * (保存→chokidar→SSE notes_changed 自己受信) で setOpenDoc が走り CodeMirror が
 * 全リセットされ、カーソルがドキュメント先頭へ飛ぶ (既存不具合 / main にも存在)。
 *
 * 修正: handleSseNotesChanged の非 dirty 再読込で「取得内容 == エディタ現在値」なら
 * 再読込しない (自己エコー抑制)。真の外部変更 (内容差あり) のときだけ再読込する。
 *
 * このテストは EventSource を mock 注入し notes_changed を発火して、
 * (A) 同一内容の自己エコー → カーソルが編集行に留まる、
 * (B) 内容差のある外部変更 → 再読込され本文が更新される、
 * を決定的に検証する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-07';
const JOURNAL_PATH = `journals/${TODAY}.md`;
const BODY = `# ${TODAY}\n\n段落一\n段落二\n段落三\n`;

const MOCK_ES_SCRIPT = `
(function() {
  window.__lastMockES = null;
  window.EventSource = function(url) {
    var instance = { url: url, onmessage: null, onerror: null,
      close: function(){ this.closed = true; },
      _dispatch: function(data){ if (this.onmessage) this.onmessage({ data: data }); } };
    window.__lastMockES = instance;
    return instance;
  };
  window.EventSource.CONNECTING = 0; window.EventSource.OPEN = 1; window.EventSource.CLOSED = 2;
})();
`;

interface MockESWindow {
  __lastMockES: { onmessage: ((e: { data: string }) => void) | null; _dispatch: (data: string) => void } | null;
}

async function boot(page: Page, getNoteBody: string): Promise<void> {
  await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals', mtime: 1000, size: 100 }] }));
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json({ date: TODAY, path: JOURNAL_PATH, content: BODY, frontmatter: null, body: BODY, created: false, mtime: 1000 }));
  });
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: null } }));
  });
  // autosave PUT + getNote GET (同一 URL, method で分岐)
  await page.route(`**/api/notes/journals/**`, (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    // GET getNote: SSE 再読込が取りに来る本文 (テストで自己エコー/外部変更を切替)
    void route.fulfill(json({ path: JOURNAL_PATH, content: getNoteBody, frontmatter: null, body: getNoteBody, created: false, mtime: 2000 }));
  });
  // getNoteMeta (SSE upsert が最初に呼ぶ)。/meta は journals/** より後に登録して優先させる
  // (Playwright は後登録ルート優先)。
  await page.route(`**/api/notes/journals/**/meta`, (route) => {
    void route.fulfill(json({ path: JOURNAL_PATH, headings: [], outgoingLinks: [], tags: [], frontmatter: null, mtime: 2000, wordCount: 0, charCount: 0 }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('段落二');
}

function activeLineText(page: Page) {
  return page.locator('[data-testid="editor"] .cm-activeLine').first();
}

test('[MOCK] SSE 自己エコー (同一内容) ではカーソルが編集行に留まる (先頭へ飛ばない)', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  // 自己エコー: getNote は編集後と同一内容を返す
  const edited = BODY.replace('段落二', '段落二X');
  await boot(page, edited);

  // 「段落二」行にカーソルを置いて X を入力 (dirty → autosave)
  await page.locator('[data-testid="editor"] .cm-line', { hasText: '段落二' }).first().click();
  await page.keyboard.press('End');
  const putReq = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/notes/journals/'));
  await page.keyboard.type('X');
  await putReq; // autosave 完了 (dirty=false)
  await expect(activeLineText(page)).toContainText('段落二X');

  // 自己エコーの notes_changed (upsert, 同一内容) を注入
  await page.evaluate((p) => {
    const w = window as unknown as MockESWindow;
    w.__lastMockES?._dispatch(JSON.stringify({ type: 'notes_changed', path: p, op: 'upsert' }));
  }, JOURNAL_PATH);

  // カーソルは編集行 (段落二X) に留まる = 先頭 (# 見出し) へ飛ばない
  await page.waitForTimeout(500);
  await expect(activeLineText(page)).toContainText('段落二X');
  await expect(activeLineText(page)).not.toContainText(TODAY); // 見出し行ではない
});

test('[MOCK] SSE 外部変更 (内容差あり) では再読込され本文が更新される (自己エコー抑制が過剰でない)', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  // 外部変更: getNote は異なる内容 (別プロセスの編集) を返す
  const external = `# ${TODAY}\n\n段落一\n段落二\n段落三\n外部で追記された行\n`;
  await boot(page, external);

  await expect(page.getByTestId('editor')).not.toContainText('外部で追記された行');

  // 非 dirty のまま外部変更 notes_changed を注入 → 自動リロードされる
  await page.evaluate((p) => {
    const w = window as unknown as MockESWindow;
    w.__lastMockES?._dispatch(JSON.stringify({ type: 'notes_changed', path: p, op: 'upsert' }));
  }, JOURNAL_PATH);

  // 本文が外部内容へ更新される (内容差ありは従来どおり再読込)
  await expect(page.getByTestId('editor')).toContainText('外部で追記された行', { timeout: 3000 });
});
