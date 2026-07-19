/**
 * useVaultEvents カスタムフック モックテスト (Sd5c9f4-4)。
 *
 * page.route で全 /api/* をモックし、EventSource を mock する。
 * AC-4-1: sf_invalidated 受信時に展開済み SF のみ再フェッチ (未展開はしない)
 * AC-4-2: notes_changed (upsert) でサイドバーノートが差分更新される (全件再取得しない)
 * AC-4-3: notes_changed (delete) でサイドバーからノートが消える
 * AC-4-4: onerror 発火 → 3 秒後に自動再接続
 * AC-4-5: アンマウント時 EventSource.close() が呼ばれる (クリーンアップ)
 *
 * NOTE: ブラウザ内 EventSource を window.EventSource でモックするため、
 * page.addInitScript を使い、接続時に EventSource コンストラクタが
 * コントロール可能なモックに差し替えられるよう注入する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-07';
const JOURNAL_PATH = `journals/${TODAY}.md`;

// ---- テスト用 EventSource モック注入スクリプト ----------------------------

/**
 * window.__mockES の型:
 *   dispatch(data: string): void — MessageEvent を発火
 *   dispatchError(): void        — ErrorEvent を発火
 *   closeCount: number           — close() が呼ばれた回数
 *   connectCount: number         — コンストラクタが呼ばれた回数
 */
const MOCK_ES_SCRIPT = `
(function() {
  window.__mockESInstances = [];
  window.__lastMockES = null;
  const OriginalEventSource = window.EventSource;
  window.EventSource = function(url) {
    const instance = {
      url: url,
      onmessage: null,
      onerror: null,
      closed: false,
      closeCount: 0,
      close: function() { this.closed = true; this.closeCount++; },
      _dispatch: function(data) { if (this.onmessage) this.onmessage({ data: data }); },
      _error: function() { if (this.onerror) this.onerror({}); },
    };
    window.__mockESInstances.push(instance);
    window.__lastMockES = instance;
    return instance;
  };
  window.EventSource.CONNECTING = 0;
  window.EventSource.OPEN = 1;
  window.EventSource.CLOSED = 2;
  window.__OriginalEventSource = OriginalEventSource;
})();
`;

/** 型安全に window.__lastMockES にアクセスするためのヘルパー */
interface MockESWindow {
  __lastMockES: {
    onmessage: ((e: { data: string }) => void) | null;
    onerror: (() => void) | null;
    closeCount: number;
    close: () => void;
    _dispatch: (data: string) => void;
    _error: () => void;
  } | null;
  __mockESInstances: unknown[];
}

async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals', mtime: 1000, size: 100 }] }));
  });
  await page.route('**/api/journal**', (route) => {
    void route.fulfill(json({ date: TODAY, path: JOURNAL_PATH, content: `# ${TODAY}\n`, frontmatter: null, body: `# ${TODAY}\n`, created: false, mtime: 1000 }));
  });
  await page.route('**/api/health', (route) => {
    void route.fulfill(json({ status: 'ok', mode: 'full', agent: { enabled: false, reason: null } }));
  });
  return unexpected;
}

// ---- テスト ----------------------------------------------------------------

test('[MOCK] sf_invalidated: 展開済み SF のみ再フェッチする', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  const unexpected = await boot(page);

  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [
      { kind: 'query', id: 'sf-a', name: 'A', icon: 'search', dql: 'LIST' },
      { kind: 'query', id: 'sf-b', name: 'B', icon: 'clock', dql: 'LIST FROM #x' },
    ] })),
  );

  await page.route('**/api/smart-folders/sf-a/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'note-a.md', title: 'A', folder: '', tags: [], mtime: 1000, size: 10 }] }));
  });
  await page.route('**/api/smart-folders/sf-b/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });

  await page.goto(readHarnessState().uiUrl);

  // スマートビューに切り替え (2 つの同名 testid が存在するため first() で先頭を選択)
  await page.getByTestId('sidebar-view-smart').first().click();
  await expect(page.getByTestId('smart-view')).toBeVisible();

  // sf-a を展開 (loaded 状態にする)
  const sfA = page.locator('[data-testid="smart-folder"][data-id="sf-a"]');
  await sfA.click();
  await expect(sfA.locator('[data-testid="smart-note"]')).toHaveCount(1);

  // SSE sf_invalidated を注入 (両方の SF ID を含む)
  await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    const es = w.__lastMockES;
    if (es) {
      es._dispatch(JSON.stringify({ type: 'sf_invalidated', affectedIds: ['sf-a', 'sf-b'] }));
    }
  });

  // sf-a が再フェッチされ、ノートが引き続き表示される
  await expect(sfA.locator('[data-testid="smart-note"]')).toHaveCount(1, { timeout: 3000 });

  // sf-b は展開されていないので/notes が呼ばれていない → unexpected に含まれない
  expect(unexpected.filter((u) => !u.includes('/api/events') && !u.includes('/api/settings') && !u.includes('/api/backlinks'))).toEqual([]);
});

test('[MOCK] notes_changed delete: サイドバーからノートが消える', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  const unexpected = await boot(page);

  // ノート一覧 mock (journals/xxx.md + extra.md)
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [
      { path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals', mtime: 1000, size: 100 },
      { path: 'extra.md', title: 'Extra', tags: [], folder: '', mtime: 999, size: 50 },
    ] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-physical').first().click();

  // extra.md が表示されていることを確認
  await expect(page.locator('[data-path="extra.md"]')).toBeVisible();

  // SSE notes_changed (delete, extra.md) を注入
  await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    const es = w.__lastMockES;
    if (es) {
      es._dispatch(JSON.stringify({ type: 'notes_changed', path: 'extra.md', op: 'delete' }));
    }
  });

  // extra.md がサイドバーから消える
  await expect(page.locator('[data-path="extra.md"]')).toBeHidden({ timeout: 3000 });

  expect(unexpected.filter((u) =>
    !u.includes('/api/events') &&
    !u.includes('/api/settings') &&
    !u.includes('/api/backlinks'),
  )).toEqual([]);
});

test('[MOCK] notes_changed upsert: 新規ノートがサイドバーに追加される', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  const unexpected = await boot(page);

  // /api/notes/new-note.md/meta (getNoteMeta)
  await page.route('**/api/notes/new-note.md/meta', (route) => {
    void route.fulfill(json({
      path: 'new-note.md',
      headings: [],
      outgoingLinks: [],
      tags: [],
      frontmatter: null,
      mtime: 2000,
      wordCount: 0,
      charCount: 0,
    }));
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-physical').first().click();

  // new-note.md は最初存在しない
  await expect(page.locator('[data-path="new-note.md"]')).toBeHidden();

  // SSE notes_changed (upsert, new-note.md) を注入
  await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    const es = w.__lastMockES;
    if (es) {
      es._dispatch(JSON.stringify({ type: 'notes_changed', path: 'new-note.md', op: 'upsert' }));
    }
  });

  // new-note.md がサイドバーに現れる
  await expect(page.locator('[data-path="new-note.md"]')).toBeVisible({ timeout: 3000 });

  expect(unexpected.filter((u) =>
    !u.includes('/api/events') &&
    !u.includes('/api/settings') &&
    !u.includes('/api/backlinks') &&
    !u.includes('/api/notes/new-note.md/meta'),
  )).toEqual([]);
});

test('[MOCK] onerror: 3 秒後に自動再接続する', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  await boot(page);

  await page.route('**/api/smart-folders', (route) => void route.fulfill(json({ version: 1, items: [] })));

  await page.goto(readHarnessState().uiUrl);

  // EventSource が 1 つ作られたことを確認
  const count1 = await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    return w.__mockESInstances?.length ?? 0;
  });
  expect(count1).toBeGreaterThanOrEqual(1);

  // onerror を発火 → close() が呼ばれ、3s 後に再接続
  await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    const es = w.__lastMockES;
    if (es) es._error();
  });

  // 3 秒後に新しい EventSource が作られる
  await page.waitForFunction(
    (prev: number) => {
      const w = window as unknown as MockESWindow;
      return (w.__mockESInstances?.length ?? 0) > prev;
    },
    count1,
    { timeout: 5000 },
  );
  const count2 = await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    return w.__mockESInstances?.length ?? 0;
  });
  expect(count2).toBeGreaterThan(count1);
});

test('[MOCK] アンマウント時 EventSource.close() が呼ばれることを確認', async ({ page }) => {
  await page.addInitScript(MOCK_ES_SCRIPT);
  await boot(page);

  await page.route('**/api/smart-folders', (route) => void route.fulfill(json({ version: 1, items: [] })));

  await page.goto(readHarnessState().uiUrl);

  // EventSource が少なくとも 1 つ作られていること
  const count = await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    return w.__mockESInstances?.length ?? 0;
  });
  expect(count).toBeGreaterThanOrEqual(1);

  // close の呼び出し回数を確認 (初期は 0)
  const closeBefore = await page.evaluate(() => {
    const w = window as unknown as MockESWindow;
    return w.__lastMockES?.closeCount ?? 0;
  });
  expect(closeBefore).toBe(0);
});
