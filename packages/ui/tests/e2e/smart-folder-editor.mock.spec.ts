/**
 * Story S7b2f22-1 + S7b2f22-2 mock テスト。
 * page.route で全 /api/* をモックする。
 *
 * S7b2f22-1 ACs (既存): フォーム開閉 / プリセット DQL / pin 種別 / アイコン保存 / PUT 検証 / read-only
 * S7b2f22-2 ACs (新規): pin パスピッカー / アイコンピッカー / +ボタン配置 /
 *                        削除確認 / DnD 並べ替え / 右クリックメニュー / read-only 保護
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const TODAY = '2026-07-08';
const JOURNAL_PATH = `journals/${TODAY}.md`;

// --------------------------------------------------------------------------
// 共通 boot
// --------------------------------------------------------------------------

async function boot(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: JOURNAL_PATH, title: TODAY, tags: [], folder: 'journals' },
          { path: 'notes/alpha.md', title: 'Alpha ノート', tags: [], folder: 'notes' },
          { path: 'notes/beta.md', title: 'Beta ノート', tags: [], folder: 'notes' },
        ],
      }),
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

/** スマートビューへ切替し、sf-form が開いている状態にして返す */
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

  await expect(page.getByTestId('sf-form-name')).toBeVisible();
  await expect(page.getByTestId('sf-form-icon')).toBeVisible();
  await expect(page.getByTestId('sf-form-kind-query')).toBeVisible();
  await expect(page.getByTestId('sf-form-kind-pin')).toBeVisible();

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

  await page.selectOption('[data-testid="sf-form-preset"]', 'recent');
  await page.getByTestId('sf-form-preset-n').fill('5');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue(
    'LIST SORT file.mtime DESC LIMIT 5',
  );

  await page.selectOption('[data-testid="sf-form-preset"]', 'tag');
  await page.getByTestId('sf-form-preset-tag').fill('mytag');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue('LIST FROM #mytag');

  await page.selectOption('[data-testid="sf-form-preset"]', 'journal');
  await page.getByTestId('sf-form-preset-n').fill('3');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue(
    'LIST FROM "journals" SORT file.name DESC LIMIT 3',
  );

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

  await expect(page.getByTestId('sf-form-dql')).toBeVisible();
  await expect(page.getByTestId('sf-form-path')).not.toBeVisible();

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

  const folder = page.locator('[data-testid="smart-folder"]').first();
  await expect(folder).toBeVisible();
  await expect(
    folder.locator('[data-testid="smart-folder-icon"]'),
  ).toHaveAttribute('data-icon', 'clock');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-1-5] PUT リクエスト検証 (query)
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
// [AC-S7b2f22-1-5] PUT リクエスト検証 (pin)
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
  // notes/alpha.md は boot モックに含まれる有効なパス (Sebf6b0-2: 存在検証により有効なパスが必要)
  await page.getByTestId('sf-form-path').focus();
  await page.getByTestId('sf-form-path').fill('notes/alpha.md');
  await page.getByTestId('sf-form-name').click(); // ドロップダウンを閉じる
  await page.getByTestId('sf-form-save').click();

  await expect(page.getByTestId('sf-form')).not.toBeVisible();

  expect(capturedBody).not.toBeNull();
  const items = capturedBody!.items as Array<{ kind: string; path: string }>;
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe('pin');
  expect(items[0]?.path).toBe('notes/alpha.md');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-1] pin パス インクリメンタルピッカー
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-1] sf-form-path に入力するとノート候補が表示され、クリックで選択される', async ({
  page,
}) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  await page.getByTestId('sf-form-kind-pin').click();
  await expect(page.getByTestId('sf-form-path')).toBeVisible();

  // フォーカスでノートロード → 候補が表示される
  await page.getByTestId('sf-form-path').focus();

  // 'alpha' と入力して候補をフィルタ
  await page.getByTestId('sf-form-path').fill('alpha');
  const option = page.locator('[data-testid="sf-form-path-option"]').first();
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute('data-path', 'notes/alpha.md');

  // クリックでパスが入力される
  await option.click();
  await expect(page.getByTestId('sf-form-path')).toHaveValue('notes/alpha.md');

  // 候補が閉じる
  await expect(page.locator('[data-testid="sf-form-path-option"]')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-2] アイコン インクリメンタルピッカー
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-2] sf-form-icon に入力するとアイコン候補が表示され、クリックで選択される', async ({
  page,
}) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await openForm(page);

  // 'clo' と入力して 'clock' を絞り込む
  await page.getByTestId('sf-form-icon').focus();
  await page.getByTestId('sf-form-icon').fill('clo');
  const option = page.locator('[data-testid="sf-form-icon-option"][data-icon="clock"]');
  await expect(option).toBeVisible();

  // クリックで選択
  await option.click();
  await expect(page.getByTestId('sf-form-icon')).toHaveValue('clock');
  await expect(page.locator('[data-testid="sf-form-icon-option"]')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S7b2f22-2-2] アイコンを保存するとリストに data-icon 属性付きで描画される', async ({
  page,
}) => {
  const unexpected = await boot(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let savedItems: Array<Record<string, unknown>> = [];
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

  await page.getByTestId('sf-form-name').fill('スター');
  // アイコンピッカーで 'star' を選択
  await page.getByTestId('sf-form-icon').focus();
  await page.getByTestId('sf-form-icon').fill('star');
  const opt = page.locator('[data-testid="sf-form-icon-option"][data-icon="star"]');
  await expect(opt).toBeVisible();
  await opt.click();
  await expect(page.getByTestId('sf-form-icon')).toHaveValue('star');

  await page.selectOption('[data-testid="sf-form-preset"]', 'todo');
  await page.getByTestId('sf-form-save').click();
  await expect(page.getByTestId('sf-form')).not.toBeVisible();

  await expect(
    page.locator('[data-testid="smart-folder-icon"][data-icon="star"]'),
  ).toBeVisible();

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-3] +ボタンの配置 — smart-view-add はトグルと同じ行
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-3] smart-view-add はノート/スマートトグルと同じヘッダ行に配置される', async ({
  page,
}) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });
  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.getByTestId('smart-view-add')).toBeVisible();

  // スマートビュートグルと + ボタンが同じ共通コンテナ内にある
  const header = page.getByTestId('smart-view-header');
  await expect(header.getByTestId('sidebar-view-smart')).toBeVisible();
  await expect(header.getByTestId('smart-view-add')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-4] 削除確認ダイアログ
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-4] 右クリック→削除で確認ダイアログが開き、キャンセルでアイテムが残る', async ({
  page,
}) => {
  const unexpected = await boot(page);

  const item = { kind: 'query', id: 'q-del', name: '削除テスト', icon: 'star', dql: 'LIST' };
  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let savedItems: Array<Record<string, unknown>> = [item];
  await page.route('**/api/smart-folders', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as SfBody;
      savedItems = body.items;
      void route.fulfill(json({ version: 1, items: savedItems }));
    } else {
      void route.fulfill(json({ version: 1, items: savedItems }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.locator('[data-testid="smart-folder"][data-id="q-del"]')).toBeVisible();

  // 右クリックでコンテキストメニューを開く
  await page.locator('[data-testid="smart-folder"][data-id="q-del"]').click({ button: 'right' });
  await expect(page.getByTestId('smart-context-menu')).toBeVisible();
  await page.getByTestId('smart-context-delete').click();

  // 削除確認ダイアログが表示される
  await expect(page.getByTestId('smart-delete-dialog')).toBeVisible();
  await expect(page.getByTestId('smart-delete-cancel')).toBeVisible();
  await expect(page.getByTestId('smart-delete-confirm')).toBeVisible();

  // キャンセル → アイテムが残る
  await page.getByTestId('smart-delete-cancel').click();
  await expect(page.getByTestId('smart-delete-dialog')).not.toBeVisible();
  await expect(page.locator('[data-testid="smart-folder"][data-id="q-del"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-S7b2f22-2-4] 削除確認ダイアログで確定するとアイテムが消え PUT される', async ({
  page,
}) => {
  const unexpected = await boot(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let savedItems: Array<Record<string, unknown>> = [
    { kind: 'query', id: 'q-keep', name: '残すフォルダ', dql: 'LIST' },
    { kind: 'query', id: 'q-del2', name: '削除対象', dql: 'LIST' },
  ];
  let lastPutItems: Array<Record<string, unknown>> | null = null;
  await page.route('**/api/smart-folders', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as SfBody;
      savedItems = body.items;
      lastPutItems = savedItems;
      void route.fulfill(json({ version: 1, items: savedItems }));
    } else {
      void route.fulfill(json({ version: 1, items: savedItems }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.locator('[data-testid="smart-folder"][data-id="q-del2"]')).toBeVisible();

  // 右クリック → 削除 → 確定
  await page.locator('[data-testid="smart-folder"][data-id="q-del2"]').click({ button: 'right' });
  await page.getByTestId('smart-context-delete').click();
  await expect(page.getByTestId('smart-delete-dialog')).toBeVisible();
  await page.getByTestId('smart-delete-confirm').click();

  // アイテムが消える
  await expect(page.locator('[data-testid="smart-folder"][data-id="q-del2"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="smart-folder"][data-id="q-keep"]')).toBeVisible();

  // PUT body に q-del2 が含まれない
  expect(lastPutItems).not.toBeNull();
  const putIds = (lastPutItems as unknown as Array<{ id: string }>).map((i) => i.id);
  expect(putIds).not.toContain('q-del2');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-5] DnD 並べ替え
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-5] アイテムをドラッグ&ドロップで並べ替えると PUT される', async ({
  page,
}) => {
  const unexpected = await boot(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let savedItems: Array<Record<string, unknown>> = [
    { kind: 'query', id: 'dnd-a', name: 'A フォルダ', dql: 'LIST' },
    { kind: 'query', id: 'dnd-b', name: 'B フォルダ', dql: 'LIST' },
  ];
  let lastPutItems: Array<Record<string, unknown>> | null = null;
  await page.route('**/api/smart-folders', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as SfBody;
      savedItems = body.items;
      lastPutItems = savedItems;
      void route.fulfill(json({ version: 1, items: savedItems }));
    } else {
      void route.fulfill(json({ version: 1, items: savedItems }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  const folders = page.locator('[data-testid="smart-folder"]');
  await expect(folders.first()).toContainText('A フォルダ');
  await expect(folders.nth(1)).toContainText('B フォルダ');

  // A → B の位置にドラッグ (B の後ろへ)
  const srcEl = page.locator('[data-testid="smart-folder"][data-id="dnd-a"]');
  const tgtEl = page.locator('[data-testid="smart-folder"][data-id="dnd-b"]');
  await srcEl.dragTo(tgtEl);

  // PUT が呼ばれて順序が変わっている
  await expect(async () => {
    expect(lastPutItems).not.toBeNull();
    const ids = (lastPutItems as Array<{ id: string }>).map((i) => i.id);
    expect(ids.indexOf('dnd-b')).toBeLessThan(ids.indexOf('dnd-a'));
  }).toPass({ timeout: 5000 });

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-6] 右クリックコンテキストメニューで編集
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-6] 右クリック → smart-context-edit でフォームが prefill 付きで開く', async ({
  page,
}) => {
  const unexpected = await boot(page);

  const existingItem = {
    kind: 'query', id: 'q-edit', name: '編集対象フォルダ', icon: 'star', dql: 'LIST WHERE bookmark',
  };
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [existingItem] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await expect(page.locator('[data-testid="smart-folder"][data-id="q-edit"]')).toBeVisible();

  // 右クリック
  await page.locator('[data-testid="smart-folder"][data-id="q-edit"]').click({ button: 'right' });
  await expect(page.getByTestId('smart-context-menu')).toBeVisible();
  await expect(page.getByTestId('smart-context-edit')).toBeVisible();
  await expect(page.getByTestId('smart-context-delete')).toBeVisible();

  // 編集をクリック → フォームが prefill されて開く
  await page.getByTestId('smart-context-edit').click();
  await expect(page.getByTestId('sf-form')).toBeVisible();
  await expect(page.getByTestId('sf-form-name')).toHaveValue('編集対象フォルダ');
  await expect(page.getByTestId('sf-form-icon')).toHaveValue('star');
  await expect(page.getByTestId('sf-form-dql')).toHaveValue('LIST WHERE bookmark');

  // コンテキストメニューは閉じている
  await expect(page.getByTestId('smart-context-menu')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S7b2f22-2-6] Escape キーでコンテキストメニューが閉じる', async ({ page }) => {
  const unexpected = await boot(page);
  await page.route('**/api/smart-folders', (route) =>
    void route.fulfill(
      json({ version: 1, items: [{ kind: 'query', id: 'q1', name: 'Q', dql: 'LIST' }] }),
    ),
  );

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();
  await page.locator('[data-testid="smart-folder"][data-id="q1"]').click({ button: 'right' });
  await expect(page.getByTestId('smart-context-menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('smart-context-menu')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-S7b2f22-2-7] read-only: no add / no context menu actions / not draggable
// --------------------------------------------------------------------------

test('[AC-S7b2f22-2-7] read-only では smart-view-add が非表示', async ({ page }) => {
  const unexpected = await boot(page);
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
  await expect(page.getByTestId('smart-view-add')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-S7b2f22-2-7] append-only モードでも smart-view-add が非表示', async ({ page }) => {
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

test('[AC-S7b2f22-2-7] read-only では右クリックしてもコンテキストメニューが出ない', async ({
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

  // 項目は描画される
  await expect(page.locator('[data-testid="smart-folder"][data-id="q1"]')).toBeVisible();
  await expect(page.locator('[data-testid="smart-pin"][data-id="p1"]')).toBeVisible();

  // + ボタンは存在しない
  await expect(page.getByTestId('smart-view-add')).toHaveCount(0);

  // 右クリックしてもコンテキストメニューが出ない
  await page.locator('[data-testid="smart-folder"][data-id="q1"]').click({ button: 'right' });
  await expect(page.getByTestId('smart-context-menu')).toHaveCount(0);

  // draggable 属性が付いていない (full モード以外)
  const folderEl = page.locator('[data-testid="smart-folder"][data-id="q1"]');
  const draggable = await folderEl.getAttribute('draggable');
  expect(draggable === null || draggable === 'false').toBe(true);

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// 後方互換テスト: [AC-S7b2f22-1-7] read-only (旧 testid なし を担保)
// --------------------------------------------------------------------------

test('[AC-S7b2f22-1-7] read-only では項目があっても旧ボタン類が一切描画されない', async ({
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

  await expect(page.locator('[data-testid="smart-folder"][data-id="q1"]')).toBeVisible();
  await expect(page.locator('[data-testid="smart-pin"][data-id="p1"]')).toBeVisible();

  // authoring 導線は一切無い
  await expect(page.getByTestId('smart-view-add')).toHaveCount(0);
  // 削除/編集 ボタン (旧 testid) は存在しない (S7b2f22-2 で inline ボタン廃止)
  await expect(page.getByTestId('smart-folder-edit')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-delete')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-moveup')).toHaveCount(0);
  await expect(page.getByTestId('smart-folder-movedown')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-Sebf6b0-2-1] フォルダ候補が pin コンボボックスに表示される
// --------------------------------------------------------------------------

test('[AC-Sebf6b0-2-1] sf-form-path に "proj" を入力するとフォルダ候補が表示される', async ({
  page,
}) => {
  // boot の notes: journals/2026-07-08.md (folder=journals), notes/alpha.md (folder=notes), notes/beta.md (folder=notes)
  // ここでは projects/ フォルダ配下のノートを返すように上書き
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'projects/design.md', title: 'Design', tags: [], folder: 'projects' },
          { path: 'projects/sub/detail.md', title: 'Detail', tags: [], folder: 'projects/sub' },
          { path: 'notes/alpha.md', title: 'Alpha', tags: [], folder: 'notes' },
        ],
      }),
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
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await openForm(page);
  await page.getByTestId('sf-form-kind-pin').click();
  await expect(page.getByTestId('sf-form-path')).toBeVisible();

  // フォーカスしてノートをロード
  await page.getByTestId('sf-form-path').focus();
  // "proj" でフィルタ → フォルダ候補 "projects" が表示される
  await page.getByTestId('sf-form-path').fill('proj');

  const folderOption = page.locator('[data-testid="sf-form-path-option"][data-path="projects"]');
  await expect(folderOption).toBeVisible({ timeout: 5000 });

  // クリックでパスが入力される (末尾 / なしのパスが設定される)
  await folderOption.click();
  await expect(page.getByTestId('sf-form-path')).toHaveValue('projects');

  // ドロップダウンが閉じる
  await expect(page.locator('[data-testid="sf-form-path-option"]')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('[AC-Sebf6b0-2-1] 祖先フォルダも候補に含まれる (projects/sub → projects も表示)', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'projects/sub/detail.md', title: 'Detail', tags: [], folder: 'projects/sub' },
        ],
      }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\n`;
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
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(json({ version: 1, items: [] }));
  });

  await page.goto(readHarnessState().uiUrl);
  await openForm(page);
  await page.getByTestId('sf-form-kind-pin').click();
  await page.getByTestId('sf-form-path').focus();

  // 入力なしで全候補を表示
  await page.getByTestId('sf-form-path').fill('');

  // projects と projects/sub 両方が表示される
  await expect(page.locator('[data-testid="sf-form-path-option"][data-path="projects"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="sf-form-path-option"][data-path="projects/sub"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-Sebf6b0-2-2] 存在しないパスでエラー表示
// --------------------------------------------------------------------------

test('[AC-Sebf6b0-2-2] 存在しないパスで保存するとエラーが表示されフォームが閉じない', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'notes/alpha.md', title: 'Alpha', tags: [], folder: 'notes' },
        ],
      }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\n`;
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
  await page.route('**/api/smart-folders', (route) => {
    // PUT は来てはいけない → fulfill のみ GET 用
    if (route.request().method() === 'PUT') {
      // このテストでは PUT が呼ばれるべきでない
      void route.fulfill({ status: 500, body: 'should not PUT' });
    } else {
      void route.fulfill(json({ version: 1, items: [] }));
    }
  });

  await page.goto(readHarnessState().uiUrl);
  await openForm(page);
  await page.getByTestId('sf-form-kind-pin').click();

  // notes をロードするためにフォーカス
  await page.getByTestId('sf-form-path').focus();
  // 存在しないパスを入力
  await page.getByTestId('sf-form-path').fill('nope/none');
  // ドロップダウンを閉じるために名前フィールドをクリック
  await page.getByTestId('sf-form-name').click();

  // 保存を試みる
  await page.getByTestId('sf-form-save').click();

  // エラーが表示される
  await expect(page.getByTestId('sf-form-error')).toBeVisible();
  await expect(page.getByTestId('sf-form-error')).toContainText('存在しないパスです');

  // フォームは閉じていない
  await expect(page.getByTestId('sf-form')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[AC-Sebf6b0-2-2] 存在するノートパスなら保存できる', async ({ page }) => {
  const unexpected = await installCatchAll(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let capturedBody: SfBody | null = null;

  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'notes/alpha.md', title: 'Alpha', tags: [], folder: 'notes' },
        ],
      }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\n`;
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

  // 注意: ノートをロードするためにフォーカスが必要
  await page.getByTestId('sf-form-path').focus();
  await page.getByTestId('sf-form-path').fill('notes/alpha.md');
  await page.getByTestId('sf-form-name').click();
  await page.getByTestId('sf-form-save').click();

  // エラーなく保存できる
  await expect(page.getByTestId('sf-form-error')).toHaveCount(0);
  await expect(page.getByTestId('sf-form')).not.toBeVisible();
  expect(capturedBody).not.toBeNull();

  expect(unexpected).toEqual([]);
});

test('[AC-Sebf6b0-2-2] 存在するフォルダパスなら保存できる', async ({ page }) => {
  const unexpected = await installCatchAll(page);

  type SfBody = { version: number; items: Array<Record<string, unknown>> };
  let capturedBody: SfBody | null = null;

  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'projects/design.md', title: 'Design', tags: [], folder: 'projects' },
        ],
      }),
    );
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\n`;
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

  await page.getByTestId('sf-form-path').focus();
  await page.getByTestId('sf-form-path').fill('projects');
  await page.getByTestId('sf-form-name').click();
  await page.getByTestId('sf-form-save').click();

  // エラーなく保存できる
  await expect(page.getByTestId('sf-form-error')).toHaveCount(0);
  await expect(page.getByTestId('sf-form')).not.toBeVisible();
  expect(capturedBody).not.toBeNull();
  const items = capturedBody!.items as Array<{ kind: string; path: string }>;
  expect(items[0]?.path).toBe('projects');

  expect(unexpected).toEqual([]);
});

// --------------------------------------------------------------------------
// [AC-Sebf6b0-2-3] folder-pin の展開 (mock)
// --------------------------------------------------------------------------

test('[AC-Sebf6b0-2-3] folder-pin (path not .md) は展開可能行として描画される', async ({
  page,
}) => {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal**', (route) => {
    const body = `# ${TODAY}\n\n`;
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
  await page.route('**/api/smart-folders', (route) => {
    void route.fulfill(
      json({
        version: 1,
        items: [
          { kind: 'pin', id: 'fp-1', name: 'Projects フォルダ', path: 'projects' },
          { kind: 'pin', id: 'np-1', name: 'Alpha ノート', path: 'notes/alpha.md' },
        ],
      }),
    );
  });
  await page.route('**/api/smart-folders/fp-1/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: 'projects/design.md', title: 'Design', tags: [], folder: 'projects' },
          { path: 'projects/plan.md', title: 'Plan', tags: [], folder: 'projects' },
        ],
      }),
    );
  });

  await page.goto(readHarnessState().uiUrl);
  await page.getByTestId('sidebar-view-smart').click();

  // folder-pin は smart-pin testid を持ち aria-expanded がある
  const folderPin = page.locator('[data-testid="smart-pin"][data-id="fp-1"]');
  await expect(folderPin).toBeVisible();
  await expect(folderPin).toHaveAttribute('aria-expanded', 'false');

  // note-pin は smart-pin testid を持つが aria-expanded がない
  const notePin = page.locator('[data-testid="smart-pin"][data-id="np-1"]');
  await expect(notePin).toBeVisible();

  // folder-pin を展開
  await folderPin.locator('button').first().click();
  await expect(folderPin).toHaveAttribute('aria-expanded', 'true');

  // 配下のノートが表示される
  await expect(
    page.locator('[data-testid="smart-note"][data-path="projects/design.md"]'),
  ).toBeVisible({ timeout: 5000 });
  await expect(
    page.locator('[data-testid="smart-note"][data-path="projects/plan.md"]'),
  ).toBeVisible();

  expect(unexpected).toEqual([]);
});
