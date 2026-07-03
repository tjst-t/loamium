/**
 * Story Sa704c3-1 mock テスト (エラー・エッジケース)。
 * page.route で全 /api/* をモックし、フロントエンドの振る舞いだけを検証する。
 * モックの形は packages/server/src/routes/*.ts の実ハンドラのレスポンス構造に一致させる
 * (gui-spec-Sa704c3-1.json の endpoint_contracts 参照)。
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

function json(body: unknown, status = 200): Parameters<Route['fulfill']>[0] {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

interface PutBody {
  content: string;
  baseMtime?: number;
}

const TODAY_JOURNAL = {
  date: '2026-07-03',
  path: 'journals/2026-07-03.md',
  content: '',
  frontmatter: null,
  body: '',
  created: false,
  mtime: 1000,
};

/** 予期しない API 呼び出しを検出する catch-all (先に登録 = 最後にマッチ)。 */
async function installCatchAll(page: Page): Promise<string[]> {
  const unexpected: string[] = [];
  await page.route('**/api/**', (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    void route.fulfill(json({ error: 'unmocked', message: 'unmocked endpoint in mock test' }, 500));
  });
  return unexpected;
}

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
