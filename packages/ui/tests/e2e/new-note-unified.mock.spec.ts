/**
 * Sa10026-8 GUI Story 「新規ノート作成のパス対応統一 + 既定フォルダ prefill + フォルダ補完」
 * mock テスト。
 *
 * page.route で全 /api/* をモックし、以下の受け入れ基準を検証する:
 * [AC-Sa10026-8-1] 統一コンポーネント(new-note-dialog)でパス入力・作成ができる
 * [AC-Sa10026-8-2] defaultFolder があれば初期値に prefill される
 * [AC-Sa10026-8-3] 既存フォルダのドロップダウン補完が動く
 *
 * data-testid 契約 (prototype/new-note-modal.html 準拠):
 *   new-note-dialog / new-note-path / new-note-path-dropdown /
 *   new-note-path-option / new-note-cancel / new-note-confirm
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json, type PutBody } from '../harness/mock-helpers.js';

const TODAY_JOURNAL = {
  date: '2026-07-14',
  path: 'journals/2026-07-14.md',
  content: '',
  frontmatter: null,
  body: '',
  created: false,
  mtime: 1000,
};

const NOTES_WITH_FOLDERS = [
  { path: 'notes/アイデア.md', title: 'アイデア', tags: [], folder: 'notes' },
  { path: 'projects/Hydra.md', title: 'Hydra', tags: [], folder: 'projects' },
  { path: 'journals/2026-07-14.md', title: '2026-07-14', tags: [], folder: 'journals' },
];

/** アプリを起動し、journal route も用意する。 */
async function boot(
  page: Page,
  opts: { defaultFolder?: string; notes?: typeof NOTES_WITH_FOLDERS } = {},
): Promise<{ unexpected: string[] }> {
  const unexpected = await installCatchAll(page);
  const df = opts.defaultFolder ?? '';

  await page.route('**/api/settings/system', (route) => {
    void route.fulfill(
      json({
        settings: {
          theme: 'system',
          defaultFolder: df,
          journalTemplate: 'system/templates/journal.md',
          showSystemFolder: false,
        },
      }),
    );
  });
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: opts.notes ?? [] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(TODAY_JOURNAL));
  });

  await page.goto(readHarnessState().uiUrl);
  return { unexpected };
}

/** サイドバーの「新規ノート ▸ 空のノート」からダイアログを開く。 */
async function openNewNoteDialog(page: Page): Promise<void> {
  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
}

// ===========================================================================
// AC-Sa10026-8-1: 統一ダイアログでパス入力・作成
// ===========================================================================

test('[AC-Sa10026-8-1][MOCK] new-note ダイアログは new-note-path 入力でパス込みノートを作成できる', async ({ page }) => {
  const putBodies: PutBody[] = [];
  const { unexpected } = await boot(page);

  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      putBodies.push(req.postDataJSON() as PutBody);
      void route.fulfill(json({ path: 'notes/アイデア.md', created: true, mtime: 999 }, 201));
      return;
    }
    void route.fallback();
  });

  await openNewNoteDialog(page);

  // new-note-path に folder/name 形式で入力
  await page.getByTestId('new-note-path').fill('notes/アイデア');
  await page.getByTestId('new-note-confirm').click();

  // PUT が .md 付きパスで呼ばれた
  expect(putBodies).toHaveLength(1);
  expect(putBodies[0]?.content).toBe('');
  expect(putBodies[0]?.baseMtime).toBe(0);

  // ダイアログが閉じる
  await expect(page.getByTestId('new-note-dialog')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-1][MOCK] .md が既に付いているパスも正常に作成できる', async ({ page }) => {
  const putPaths: string[] = [];
  const { unexpected } = await boot(page);

  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      // URL からパスを取り出す
      const url = new URL(req.url());
      putPaths.push(decodeURIComponent(url.pathname.slice('/api/notes/'.length)));
      void route.fulfill(json({ path: 'done.md', created: true, mtime: 1 }, 201));
      return;
    }
    void route.fallback();
  });

  await openNewNoteDialog(page);
  // 既に .md 付きで入力しても重複しない
  await page.getByTestId('new-note-path').fill('memo/テスト.md');
  await page.getByTestId('new-note-confirm').click();

  expect(putPaths).toHaveLength(1);
  expect(putPaths[0]).toBe('memo/テスト.md');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-1][MOCK] 入力空のまま「作成」はボタンが disabled になる', async ({ page }) => {
  const { unexpected } = await boot(page);

  await openNewNoteDialog(page);

  // 初期値が空の場合 (defaultFolder なし)、confirm ボタンは disabled
  const confirmBtn = page.getByTestId('new-note-confirm');
  await expect(confirmBtn).toBeDisabled();

  // キャンセルは動く
  await page.getByTestId('new-note-cancel').click();
  await expect(page.getByTestId('new-note-dialog')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-1][MOCK] 409 重複エラーが app-error に表示される', async ({ page }) => {
  const { unexpected } = await boot(page);

  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      void route.fulfill(json({ error: 'conflict', message: 'note was modified by another process' }, 409));
      return;
    }
    void route.fallback();
  });

  await openNewNoteDialog(page);
  await page.getByTestId('new-note-path').fill('重複ノート');
  await page.getByTestId('new-note-confirm').click();

  await expect(page.getByTestId('app-error')).toContainText('同名のノートが既に存在します');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-1][MOCK] キャンセルで API が呼ばれない', async ({ page }) => {
  const mutations: string[] = [];
  const { unexpected } = await boot(page);

  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      mutations.push(req.url());
    }
    void route.fallback();
  });

  await openNewNoteDialog(page);
  await page.getByTestId('new-note-path').fill('捨てノート');
  await page.getByTestId('new-note-cancel').click();

  await expect(page.getByTestId('new-note-dialog')).not.toBeVisible();
  expect(mutations).toHaveLength(0);

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-1][MOCK] Esc キーでダイアログが閉じる', async ({ page }) => {
  const { unexpected } = await boot(page);

  await openNewNoteDialog(page);
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('new-note-dialog')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// AC-Sa10026-8-2: defaultFolder prefill
// ===========================================================================

test('[AC-Sa10026-8-2][MOCK] defaultFolder が設定されていれば new-note-path に prefill される', async ({ page }) => {
  const { unexpected } = await boot(page, { defaultFolder: 'notes' });

  await openNewNoteDialog(page);

  // "notes/" が prefill されている
  await expect(page.getByTestId('new-note-path')).toHaveValue('notes/');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-2][MOCK] defaultFolder が空ならば new-note-path は空で始まる', async ({ page }) => {
  const { unexpected } = await boot(page, { defaultFolder: '' });

  await openNewNoteDialog(page);

  // 空文字が初期値
  await expect(page.getByTestId('new-note-path')).toHaveValue('');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-2][MOCK] defaultFolder prefill 状態でファイル名を追記してノートを作成できる', async ({ page }) => {
  const putPaths: string[] = [];
  const { unexpected } = await boot(page, { defaultFolder: 'notes' });

  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      const url = new URL(req.url());
      putPaths.push(decodeURIComponent(url.pathname.slice('/api/notes/'.length)));
      void route.fulfill(json({ path: 'notes/新規.md', created: true, mtime: 1 }, 201));
      return;
    }
    void route.fallback();
  });

  await openNewNoteDialog(page);

  // "notes/" に "新規" を追記する
  await page.getByTestId('new-note-path').type('新規');
  await page.getByTestId('new-note-confirm').click();

  expect(putPaths).toHaveLength(1);
  expect(putPaths[0]).toBe('notes/新規.md');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-2][MOCK] defaultFolder を消してルート直下に作成できる', async ({ page }) => {
  const putPaths: string[] = [];
  const { unexpected } = await boot(page, { defaultFolder: 'notes' });

  await page.route('**/api/notes/**', (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      const url = new URL(req.url());
      putPaths.push(decodeURIComponent(url.pathname.slice('/api/notes/'.length)));
      void route.fulfill(json({ path: 'ルート.md', created: true, mtime: 1 }, 201));
      return;
    }
    void route.fallback();
  });

  await openNewNoteDialog(page);

  // prefill "notes/" を消してファイル名だけ入力
  await page.getByTestId('new-note-path').fill('ルート');
  await page.getByTestId('new-note-confirm').click();

  expect(putPaths).toHaveLength(1);
  expect(putPaths[0]).toBe('ルート.md');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// AC-Sa10026-8-3: フォルダ補完ドロップダウン
// ===========================================================================

test('[AC-Sa10026-8-3][MOCK] フォーカス時にフォルダ候補のドロップダウンが表示される', async ({ page }) => {
  const { unexpected } = await boot(page, { notes: NOTES_WITH_FOLDERS });

  await openNewNoteDialog(page);

  // 入力欄にフォーカスするとドロップダウンが開く
  await page.getByTestId('new-note-path').click();

  await expect(page.getByTestId('new-note-path-dropdown')).toBeVisible();
  // フォルダ候補が表示される
  await expect(page.getByTestId('new-note-path-option')).toHaveCount(3); // notes / projects / journals

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-3][MOCK] フォルダ候補をクリックすると入力欄に "folder/" がセットされる', async ({ page }) => {
  const { unexpected } = await boot(page, { notes: NOTES_WITH_FOLDERS });

  await openNewNoteDialog(page);
  await page.getByTestId('new-note-path').click();
  await expect(page.getByTestId('new-note-path-dropdown')).toBeVisible();

  // "projects" 候補をクリック
  await page.locator('[data-testid="new-note-path-option"][data-path="projects"]').click();

  await expect(page.getByTestId('new-note-path')).toHaveValue('projects/');

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-3][MOCK] 入力でフォルダ候補が絞り込まれる', async ({ page }) => {
  const { unexpected } = await boot(page, { notes: NOTES_WITH_FOLDERS });

  await openNewNoteDialog(page);

  // "pro" と入力すると projects のみが残る
  await page.getByTestId('new-note-path').fill('pro');

  await expect(page.getByTestId('new-note-path-dropdown')).toBeVisible();
  await expect(page.getByTestId('new-note-path-option')).toHaveCount(1);
  await expect(page.locator('[data-testid="new-note-path-option"][data-path="projects"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sa10026-8-3][MOCK] defaultFolder と同じフォルダ候補には「既定」マークが付く', async ({ page }) => {
  const { unexpected } = await boot(page, {
    defaultFolder: 'notes',
    notes: NOTES_WITH_FOLDERS,
  });

  await openNewNoteDialog(page);
  await page.getByTestId('new-note-path').click();
  await expect(page.getByTestId('new-note-path-dropdown')).toBeVisible();

  // notes 候補に .mark 要素が含まれる
  const notesOption = page.locator('[data-testid="new-note-path-option"][data-path="notes"]');
  await expect(notesOption).toBeVisible();
  await expect(notesOption.locator('.mark')).toBeVisible();

  expect(unexpected).toEqual([]);
});
