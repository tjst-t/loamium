/**
 * Story S7b2f22-1 mock テスト — スマートフォルダ作成/編集/削除/並べ替え UI。
 * page.route で全 /api/* をモックする。
 * 受け入れ条件の本検証は smart-folder-editor.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-08';
const JOURNAL_PATH = `journals/${TODAY}.md`;

// --------------------------------------------------------------------------
// 共通 boot (ノート/ジャーナルのモックを設定して unexpected 配列を返す)
// --------------------------------------------------------------------------

async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\nアンカー\n`;
    void route.fulfill(
      json({
        date: TODAY,
        path: JOURNAL_PATH,
        content: body,
        frontmatter: null,
        body,
        created: false,
        mtime: 1000,
      }),
    );
  });
  return unexpected;
}

/** スマートビューへ切替し、sf-form が開いている状態にして返す共通ヘルパー */
async function openForm(page: Page): Promise<void> {
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.getByTestId('smart-view-add')).toBeVisible();
  await page.getByTestId('smart-view-add').click();
  await expect(page.getByTestId('sf-form')).toBeVisible();
}

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-1] フォームの開閉
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-1] smart-view-add クリックで作成フォームが開き、キャンセルで閉じる', async ({
  page,
}) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  // フォームに name/icon/kind の入力欄がある
  await expect(page.getByTestId('sf-form-name')).toBeVisible();
  await expect(page.getByTestId('sf-form-icon')).toBeVisible();
  await expect(page.getByTestId('sf-form-kind-query')).toBeVisible();
  await expect(page.getByTestId('sf-form-kind-pin')).toBeVisible();

  // キャンセルで閉じる
  await page.getByTestId('sf-form-cancel').click();
  await expect(page.getByTestId('sf-form')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-2] プリセット → DQL 生成
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-2] プリセット選択で sf-form-dql に正しい DQL が入力される', async ({
  page,
}) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  // recent-5
  await page.selectOption('[data-testid="sf-form-preset"]', 'recent');
  await page.getByTestId('sf-form-preset-n').fill('5');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue(
    'LIST SORT file.mtime DESC LIMIT 5',
  );

  // tag=mytag
  await page.selectOption('[data-testid="sf-form-preset"]', 'tag');
  await page.getByTestId('sf-form-preset-tag').fill('mytag');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue('LIST FROM #mytag');

  // journal-3
  await page.selectOption('[data-testid="sf-form-preset"]', 'journal');
  await page.getByTestId('sf-form-preset-n').fill('3');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue(
    'LIST FROM "journals" SORT file.name DESC LIMIT 3',
  );

  // todo
  await page.selectOption('[data-testid="sf-form-preset"]', 'todo');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue(
    'LIST WHERE file.open_tasks SORT file.mtime DESC',
  );

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-3] pin 種別でパス入力欄が表示される
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-3] pin 種別に切替えると sf-form-path が表示される', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  // 初期は query → path 非表示、dql 表示
  await expect(page.getByTestId('sf-form-dql')).toBeVisible();
  await expect(page.getByTestId('sf-form-path')).not.toBeVisible();

  // pin に切替
  await page.getByTestId('sf-form-kind-pin').click();
  await expect(page.getByTestId('sf-form-path')).toBeVisible();
  await expect(page.getByTestId('sf-form-dql')).not.toBeVisible();

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-4] アイコン保存
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-4] アイコンを指定して保存するとリストに描画される', async ({ page }) => {
  const unexpected = await boot(page);

  type SfBody = { version: number; items: Array<{ kind: string; icon?: string; name: string; dql: string; id: string }> };
  let savedItems: SfBody['items'] = [];

  await page.route('**/api/smart-folders', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as SfBody;
      savedItems = body.items;
      void route.fulfill(json({ version: 1, items: savedItems }));
    } else {
      void route.fulfill(json({ version: 1, items: savedItems }));
    }
  });
  await page.route('**/api/smart-folders/*/notes', (route) =>
    void route.fulfill(json({ notes: [] })),
  );

  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  await page.getByTestId('sf-form-name').fill('テストフォルダ');
  await page.getByTestId('sf-form-icon').fill('clock');
  await page.selectOption('[data-testid="sf-form-preset"]', 'recent');
  await page.getByTestId('sf-form-preset-n').fill('5');
  await page.getByTestId('sf-form-save').click();

  await expect(page.getByTestId('sf-form')).not.toBeVisible();

  // リストにアイコンが描画されている
  const folder = page.locator('[data-testid="smart-folder"]').first();
  await expect(folder).toBeVisible();
  await expect(
    folder.locator('[data-testid="smart-folder-icon"]'),
  ).toHaveAttribute('data-icon', 'clock');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-5] PUT /api/smart-folders のリクエスト検証 (query)
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-5] query 保存: PUT に正しい kind/name/icon/dql が送られる', async ({
  page,
}) => {
  const unexpected = await boot(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let capturedBody: SfBody | null = null;

  await page.route('**/api/smart-folders', (route) => {
    if (route.request().method() === 'PUT') {
      capturedBody = route.request().postDataJSON() as SfBody;
      void route.fulfill(json({ version: 1, items: capturedBody.items }));
    } else {
      void route.fulfill(json({ version: 1, items: [] }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  await page.getByTestId('sf-form-name').fill('最近のノート');
  await page.getByTestId('sf-form-icon').fill('clock');
  await page.selectOption('[data-testid="sf-form-preset"]', 'recent');
  await page.getByTestId('sf-form-preset-n').fill('5');
  await page.getByTestId('sf-form-save').click();

  await expect(page.getByTestId('sf-form')).not.toBeVisible();

  expect(capturedBody).not.toBeNull();
  const items = capturedBody!.items as Array<{ kind: string; name: string; icon: string; dql: string }>;
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe('query');
  expect(items[0]?.name).toBe('最近のノート');
  expect(items[0]?.icon).toBe('clock');
  expect(items[0]?.dql).toBe('LIST SORT file.mtime DESC LIMIT 5');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-5] PUT /api/smart-folders のリクエスト検証 (pin)
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-5] pin 保存: PUT に正しい kind/path が送られる', async ({ page }) => {
  const unexpected = await boot(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let capturedBody: SfBody | null = null;

  await page.route('**/api/smart-folders', (route) => {
    if (route.request().method() === 'PUT') {
      capturedBody = route.request().postDataJSON() as SfBody;
      void route.fulfill(json({ version: 1, items: capturedBody.items }));
    } else {
      void route.fulfill(json({ version: 1, items: [] }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  await page.getByTestId('sf-form-kind-pin').click();
  await page.getByTestId('sf-form-path').fill('notes/example.md');
  await page.getByTestId('sf-form-save').click();

  await expect(page.getByTestId('sf-form')).not.toBeVisible();

  expect(capturedBody).not.toBeNull();
  const items = capturedBody!.items as Array<{ kind: string; path: string }>;
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe('pin');
  expect(items[0]?.path).toBe('notes/example.md');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-7] read-only モードでは smart-view-add が非表示
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-7] read-only モードでは smart-view-add ボタンが存在しない', async ({
  page,
}) => {
  const unexpected = await boot(page);

  // health を read-only に上書き (installCatchAll の後なので上書き可)
  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'read-only', terminal: { enabled: false, reason: null } }),
    ),
  );
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [] })),
  );

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.getByTestId('smart-view-empty')).toBeVisible();

  // + ボタンは存在しない (full 以外では非描画)
  await expect(page.getByTestId('smart-view-add')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-7] append-only モードでも smart-view-add が非表示
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-7] append-only モードでも smart-view-add ボタンが存在しない', async ({
  page,
}) => {
  const unexpected = await boot(page);

  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'append-only', terminal: { enabled: false, reason: null } }),
    ),
  );
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(json({ version: 1, items: [] })),
  );

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.getByTestId('smart-view-empty')).toBeVisible();
  await expect(page.getByTestId('smart-view-add')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S7b2f22-1-7] read-only では項目があっても編集/削除/並べ替えボタンが描画されない', async ({
  page,
}) => {
  const unexpected = await boot(page);
  await page.route('**/api/health', (route) =>
    void route.fulfill(
      json({ status: 'ok', mode: 'read-only', terminal: { enabled: false, reason: null } }),
    ),
  );
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(
      json({
        version: 1,
        items: [
          { kind: 'query', id: 'q1', name: 'Q', icon: 'clock', dql: 'LIST' },
          { kind: 'pin', id: 'p1', name: 'P', icon: 'inbox', path: 'a/x.md' },
        ],
      }),
    ),
  );

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  // 項目自体は描画される
  await expect(page.locator('[data-testid="smart-folder"][data-id="q1"]')).toBeVisible();
  await expect(page.locator('[data-testid="smart-pin"][data-id="p1"]')).toBeVisible();

  // authoring 導線は一切無い (+ / 編集 / 削除 / 並べ替え)
  await expect(page.getByTestId('smart-view-add')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-edit')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-delete')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-moveup')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-movedown')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-6] 編集ボタンでフォームが prefill されて開く
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-6] 既存アイテムを編集するとフォームが prefill される', async ({ page }) => {
  const unexpected = await boot(page);

  const existingItem = { kind: 'query', id: 'q1', name: '既存フォルダ', icon: 'star', dql: 'LIST WHERE bookmark' };

  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [existingItem] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.locator('[data-testid="smart-folder"][data-id="q1"]')).toBeVisible();

  // 編集ボタンクリック
  await page.locator('[data-testid="smart-folder"][data-id="q1"]').getByTestId('smart-folder-edit').click();
  await expect(page.getByTestId('sf-form')).toBeVisible();

  // 既存値が prefill されている
  await expect(page.getByTestId('sf-form-name')).toHaveValue('既存フォルダ');
  await expect(page.getByTestId('sf-form-icon')).toHaveValue('star');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue('LIST WHERE bookmark');

  expect(unexpected).toEqual([]);
});
