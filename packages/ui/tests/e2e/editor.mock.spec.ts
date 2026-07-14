/**
 * Story Sa704c3-1 mock テスト (エラー・エッジケース)。
 * page.route で全 /api/* をモックし、フロントエンドの振る舞いだけを検証する。
 * モックの形は packages/server/src/routes/*.ts の実ハンドラのレスポンス構造に一致させる
 * (gui-spec-Sa704c3-1.json の endpoint_contracts 参照)。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json, type PutBody } from '../harness/mock-helpers.js';

const TODAY_JOURNAL = {
  date: '2026-07-03',
  path: 'journals/2026/07/2026-07-03.md',
  content: '',
  frontmatter: null,
  body: '',
  created: false,
  mtime: 1000,
};


test('[MOCK] 空 vault では tree-empty を表示し、journal 取得失敗時はエディタが empty state になる', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  let notesCalled = 0;
  let journalCalled = 0;
  await page.route('**/api/notes', (route) => {
    notesCalled += 1;
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    journalCalled += 1;
    void route.fulfill(json({ error: 'io_error', message: 'disk unavailable' }, 500));
  });

  await page.goto(readHarnessState().uiUrl);

  await expect(page.getByTestId('tree-empty')).toBeVisible();
  await expect(page.getByTestId('editor-empty-state')).toBeVisible();
  await expect(page.getByTestId('empty-open-journal')).toBeVisible();
  await expect(page.getByTestId('empty-new-note')).toBeVisible();
  await expect(page.getByTestId('app-error')).toBeVisible();
  expect(notesCalled).toBeGreaterThan(0);
  expect(journalCalled).toBeGreaterThan(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] ノート一覧の取得失敗はツリーにエラーを表示する (ジャーナルは開ける)', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ error: 'index_error', message: 'index rebuild failed' }, 500));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json({ ...TODAY_JOURNAL, content: '# きょうの日記\n', body: '# きょうの日記\n' }));
  });

  await page.goto(readHarnessState().uiUrl);

  await expect(page.getByTestId('tree-error')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('きょうの日記');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 保存失敗 (500) はエラー表示のまま dirty を維持し、PUT ボディに content と baseMtime を含む', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  const putBodies: PutBody[] = [];
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'notes/サンプル.md', title: 'サンプル', tags: [], folder: 'notes' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(
        json({ path: 'notes/サンプル.md', content: 'hello\n', frontmatter: null, body: 'hello\n', mtime: 111 }),
      );
      return;
    }
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ error: 'io_error', message: 'disk full' }, 500));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toContainText('hello');

  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' 追記');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');

  await expect(page.getByTestId('app-error')).toContainText('保存に失敗しました');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  expect(putBodies.length).toBeGreaterThan(0);
  const put = putBodies[0];
  expect(put?.content).toContain('hello');
  expect(put?.content).toContain('追記');
  expect(put?.baseMtime).toBe(111); // 読み込み時の mtime を必ず添える (楽観的競合検出)
  expect(unexpected).toEqual([]);
});

test('[MOCK] 409 conflict は競合ダイアログを出し、上書きは baseMtime なしで再 PUT する', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  const putBodies: PutBody[] = [];
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'メモ.md', title: 'メモ', tags: [], folder: '' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json({ path: 'メモ.md', content: 'v1\n', frontmatter: null, body: 'v1\n', mtime: 100 }));
      return;
    }
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as PutBody;
      putBodies.push(body);
      if (body.baseMtime !== undefined) {
        // 実サーバーの notes.ts と同じ 409 形 (error: 'conflict')
        void route.fulfill(json({ error: 'conflict', message: 'note was modified by another process' }, 409));
      } else {
        void route.fulfill(json({ path: 'メモ.md', created: false, mtime: 200 }));
      }
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toContainText('v1');

  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ローカル編集');
  await page.keyboard.press('Control+s');

  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  await page.getByTestId('conflict-overwrite').click();

  await expect(page.getByTestId('conflict-dialog')).not.toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(putBodies.length).toBe(2);
  expect(putBodies[0]?.baseMtime).toBe(100);
  expect(putBodies[1]?.baseMtime).toBeUndefined(); // 上書きは無条件 PUT (last-write-wins)
  expect(putBodies[1]?.content).toContain('ローカル編集');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 競合ダイアログの再読込は最新のサーバー内容でエディタを置き換える', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  let noteGets = 0;
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'メモ.md', title: 'メモ', tags: [], folder: '' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      noteGets += 1;
      const content = noteGets === 1 ? 'v1\n' : '外部プロセスの編集\n';
      void route.fulfill(json({ path: 'メモ.md', content, frontmatter: null, body: content, mtime: noteGets * 100 }));
      return;
    }
    if (req.method() === 'PUT') {
      void route.fulfill(json({ error: 'conflict', message: 'note was modified by another process' }, 409));
      return;
    }
    void route.fallback();
  });
  // S11493d-2: /api/notes/{path}/meta はインフォパネルが叩く定常呼び出し。
  // noteGets カウンタに影響しないよう **/meta を後 (last-win) に登録して優先させる。
  await page.route('**/api/notes/**/meta', (route) => {
    void route.fulfill(json({ path: 'メモ.md', headings: [], outgoingLinks: [], tags: [], frontmatter: null, mtime: 100, wordCount: 0, charCount: 0 }));
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('tree-item').click();
  await expect(page.getByTestId('editor')).toContainText('v1');

  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ローカル編集');
  await page.keyboard.press('Control+s');

  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  await page.getByTestId('conflict-reload').click();

  await expect(page.getByTestId('editor')).toContainText('外部プロセスの編集');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(noteGets).toBe(2);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 長いノート名や特殊文字 (#・スペース) を含むパスもツリーに表示され、開ける', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  const longName = 'とても長いノート名'.repeat(6); // 54 文字
  const specialPath = 'memo/C# と F. Sharp 比較.md';
  const requestedPaths: string[] = [];
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: `${longName}.md`, title: longName, tags: [], folder: '' },
          { path: specialPath, title: 'C# と F. Sharp 比較', tags: [], folder: 'memo' },
        ],
      }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const url = new URL(route.request().url());
    requestedPaths.push(decodeURIComponent(url.pathname));
    void route.fulfill(
      json({ path: specialPath, content: '特殊文字ノート\n', frontmatter: null, body: '特殊文字ノート\n', mtime: 1 }),
    );
  });

  await page.goto(readHarnessState().uiUrl);

  const longItem = page.locator(`[data-testid="tree-item"][data-path="${longName}.md"]`);
  await expect(longItem).toBeVisible();

  await page.locator(`[data-testid="tree-item"][data-path="${specialPath}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('特殊文字ノート');
  // パスはセグメント単位で percent-encode され、デコードすると元のパスに戻る
  expect(requestedPaths).toContain(`/api/notes/${specialPath}`);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 右サイドバーはトグルで開閉できる (シェルのみ — 結線は S6fbf45-2)', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });

  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('right-sidebar')).toBeVisible();
  // S11493d-2: backlink-panel → info-panel
  await expect(page.getByTestId('info-panel')).toBeVisible();
  await expect(page.getByTestId('backlink-empty')).toBeVisible();

  // right-sidebar-toggle でサイドバー自体を折りたたむ (Sf1a90a-2)
  await page.getByTestId('right-sidebar-toggle').click();
  await expect(page.getByTestId('right-sidebar')).toHaveClass(/collapsed/);
  await expect(page.getByTestId('backlink-empty')).not.toBeVisible();
  await expect(page.getByTestId('right-sidebar')).toBeVisible(); // 折りたたんでもバーは残る

  await page.getByTestId('right-sidebar-toggle').click();
  await expect(page.getByTestId('right-sidebar')).not.toHaveClass(/collapsed/);
  await expect(page.getByTestId('backlink-empty')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 新規ノート作成は create-only (baseMtime: 0) で PUT し、409 なら重複エラーを表示する', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  const putBodies: PutBody[] = [];
  let putCount = 0;
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json({ error: 'io_error', message: 'no journal' }, 500)); // empty state 経由で作成する
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      putCount += 1;
      putBodies.push(req.postDataJSON() as PutBody);
      if (putCount === 1) {
        void route.fulfill(json({ path: '新しいメモ.md', created: true, mtime: 500 }, 201));
      } else {
        // ツリーに無いが外部プロセスが先に作っていたケース
        void route.fulfill(json({ error: 'conflict', message: 'note was modified by another process' }, 409));
      }
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);

  // empty state の「新規ノートを作成」ボタンからダイアログを開く (empty-new-note の検証を兼ねる)
  await expect(page.getByTestId('editor-empty-state')).toBeVisible();
  await page.getByTestId('empty-new-note').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
  await page.getByTestId('new-note-input').fill('新しいメモ');
  await page.getByTestId('new-note-confirm').click();

  await expect(page.getByTestId('editor')).toBeVisible();
  expect(putBodies[0]).toEqual({ content: '', baseMtime: 0 }); // create-only セマンティクス

  // 2 回目: 外部で先に作られていた → 409 → 重複エラー表示 (黙って上書きしない)
  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click(); // 新規ノート ▸ 空のノート (S89a350-3)
  await page.getByTestId('new-note-input').fill('外部が先に作ったメモ');
  await page.getByTestId('new-note-confirm').click();
  await expect(page.getByTestId('app-error')).toContainText('同名のノートが既に存在します');
  expect(unexpected).toEqual([]);
});

test('[MOCK] ダイアログのキャンセルと context-open、F2 リネームショートカット', async ({ page }) => {
  const unexpected = await installCatchAll(page);
  const mutations: string[] = [];
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: 'メモ.md', title: 'メモ', tags: [], folder: '' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });
  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      void route.fulfill(json({ path: 'メモ.md', content: 'めもの本文\n', frontmatter: null, body: 'めもの本文\n', mtime: 1 }));
      return;
    }
    mutations.push(`${req.method()} ${req.url()}`);
    void route.fulfill(json({ error: 'unexpected', message: 'mutation must not happen in this test' }, 500));
  });

  await page.goto(readHarnessState().uiUrl);
  const item = page.locator('[data-testid="tree-item"][data-path="メモ.md"]');

  // context-open でノートが開く
  await item.click({ button: 'right' });
  await page.getByTestId('context-open').click();
  await expect(page.getByTestId('editor')).toContainText('めもの本文');

  // 新規ノートダイアログ: キャンセル
  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click(); // 新規ノート ▸ 空のノート (S89a350-3)
  await page.getByTestId('new-note-input').fill('捨てる入力');
  await page.getByTestId('new-note-cancel').click();
  await expect(page.getByTestId('new-note-dialog')).not.toBeVisible();

  // リネームダイアログ: キャンセル
  await item.click({ button: 'right' });
  await page.getByTestId('context-rename').click();
  await expect(page.getByTestId('rename-input')).toHaveValue('メモ');
  await page.getByTestId('rename-cancel').click();
  await expect(page.getByTestId('rename-dialog')).not.toBeVisible();

  // 削除ダイアログ: キャンセル (ノートは残る)
  await item.click({ button: 'right' });
  await page.getByTestId('context-delete').click();
  await page.getByTestId('delete-cancel').click();
  await expect(page.getByTestId('delete-dialog')).not.toBeVisible();
  await expect(item).toBeVisible();

  // F2 で開いているノートのリネームダイアログが開く
  await page.keyboard.press('F2');
  await expect(page.getByTestId('rename-dialog')).toBeVisible();
  await expect(page.getByTestId('rename-input')).toHaveValue('メモ');
  await page.getByTestId('rename-cancel').click();

  // キャンセル操作では書き込み API が一切呼ばれない
  expect(mutations).toEqual([]);
  expect(unexpected).toEqual([]);
});
