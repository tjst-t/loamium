/**
 * Story S1bd397-4「入力フォーム UI — 動的選択肢」mock テスト。
 * page.route で /api/options-query をモックし、エッジケースを実ブラウザで固める。
 *
 * 受け入れ本検証は dynamic-options.e2e.spec.ts (実サーバー)。
 *
 * [AC-S1bd397-4-3] 候補 0 件: 厳格 select は空+ヒント / text は自由入力フォールバック
 * [AC-S1bd397-4-4] モバイルレスポンシブ (mock で確認)
 * [AC-S1bd397-4-1/4-2] エラー時フォールバック (ネットワーク失敗)
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-23';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

// テンプレート: select+optionsQuery (loamium / webapp)
const EPIC_TEMPLATE_WITH_OPTIONSQUERY = {
  name: 'epic-optionsquery',
  path: 'system/templates/epic-optionsquery.md',
  description: 'Epic テンプレート',
  target: 'projects/{{プロジェクト名}}/epics/{{Epic名}}',
  vars: [
    {
      name: 'プロジェクト名',
      type: 'select',
      required: true,
      label: 'プロジェクト',
      optionsQuery: 'LIST FROM #project',
    },
    {
      name: 'Epic名',
      type: 'text',
      required: true,
      label: 'Epic 名',
    },
  ],
};

// テンプレート: text+optionsQuery
const AUTOCOMPLETE_TEMPLATE = {
  name: 'autocomplete-test',
  path: 'system/templates/autocomplete-test.md',
  description: 'オートコンプリートテスト',
  target: '{{タイトル}}',
  vars: [
    {
      name: 'タイトル',
      type: 'text',
      required: true,
      label: 'タイトル',
      optionsQuery: 'LIST FROM #project',
    },
  ],
};

const CANDIDATES_LOAMIUM_WEBAPP = {
  candidates: [
    { value: 'loamium', label: 'loamium' },
    { value: 'webapp', label: 'webapp' },
  ],
  truncated: false,
};

const CANDIDATES_EMPTY = { candidates: [], truncated: false };

const CANDIDATES_TRUNCATED = {
  candidates: [{ value: 'loamium', label: 'loamium' }],
  truncated: true,
};

async function boot(page: Page, templates: unknown[]): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }));
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal('# 今日\n\nメモ。\n')));
  });
  await page.route('**/api/templates', (route) => {
    void route.fulfill(json({ templates }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('メモ');
  return unexpected;
}

async function openTemplate(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-new-note').click();
  await expect(page.getByTestId('new-note-menu')).toBeVisible();
  await page.getByTestId('new-note-menu-template').click();
  await expect(page.getByTestId('template-picker')).toBeVisible();
  await page.locator(`[data-testid="template-item"][data-template="${name}"]`).click();
  await expect(page.getByTestId('template-modal')).toBeVisible();
}

// ---- AC-S1bd397-4-1: select+optionsQuery → 候補ドロップダウン ----

test('[AC-S1bd397-4-1][MOCK] select+optionsQuery: 候補が /api/options-query からロードされる', async ({
  page,
}) => {
  await boot(page, [EPIC_TEMPLATE_WITH_OPTIONSQUERY]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json(CANDIDATES_LOAMIUM_WEBAPP));
  });
  await openTemplate(page, 'epic-optionsquery');
  const modal = page.getByTestId('template-modal');

  const selectInput = modal.locator(
    '[data-testid="template-var-input"][data-var="プロジェクト名"][data-widget="dynamic-select"]',
  );
  await expect(selectInput).toBeVisible({ timeout: 5_000 });
  await expect(selectInput.locator('option', { hasText: 'loamium' })).toBeAttached();
  await expect(selectInput.locator('option', { hasText: 'webapp' })).toBeAttached();
});

test('[AC-S1bd397-4-1][MOCK] text+optionsQuery: <input>+<datalist> でオートコンプリート', async ({
  page,
}) => {
  await boot(page, [AUTOCOMPLETE_TEMPLATE]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json(CANDIDATES_LOAMIUM_WEBAPP));
  });
  await openTemplate(page, 'autocomplete-test');
  const modal = page.getByTestId('template-modal');

  const inputEl = modal.locator(
    '[data-testid="template-var-input"][data-var="タイトル"][data-widget="autocomplete"]',
  );
  await expect(inputEl).toBeVisible({ timeout: 5_000 });
  // 自由入力が可能 (候補外の値も入力できる)
  await inputEl.fill('全く新しいタイトル');
  await expect(inputEl).toHaveValue('全く新しいタイトル');
});

// ---- AC-S1bd397-4-3: 候補 0 件フォールバック ----

test('[AC-S1bd397-4-3][MOCK] select+optionsQuery 候補 0 件 → 空+ヒント表示 (フォールバック自由入力)', async ({
  page,
}) => {
  await boot(page, [EPIC_TEMPLATE_WITH_OPTIONSQUERY]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json(CANDIDATES_EMPTY));
  });
  await openTemplate(page, 'epic-optionsquery');
  const modal = page.getByTestId('template-modal');

  // 候補 0 件 → 空ヒストが表示される
  await expect(
    modal.locator('[data-testid="template-var-options-empty"][data-var="プロジェクト名"]'),
  ).toBeVisible({ timeout: 5_000 });
  // フォールバック: 自由入力 (<input type=text) に切り替わる
  await expect(
    modal.locator('[data-testid="template-var-input"][data-var="プロジェクト名"]'),
  ).toBeVisible();
});

test('[AC-S1bd397-4-3][MOCK] text+optionsQuery 候補 0 件 → 自由入力継続 (エラーにならない)', async ({
  page,
}) => {
  await boot(page, [AUTOCOMPLETE_TEMPLATE]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json(CANDIDATES_EMPTY));
  });
  await openTemplate(page, 'autocomplete-test');
  const modal = page.getByTestId('template-modal');

  // text は候補なしでも自由入力で使える
  const inputEl = modal.locator('[data-testid="template-var-input"][data-var="タイトル"]');
  await expect(inputEl).toBeVisible({ timeout: 5_000 });
  await inputEl.fill('新規プロジェクト名');
  await expect(inputEl).toHaveValue('新規プロジェクト名');
});

// ---- 候補打ち切りヒント ----

test('[MOCK] truncated=true のとき打ち切りヒントが表示される', async ({ page }) => {
  await boot(page, [EPIC_TEMPLATE_WITH_OPTIONSQUERY]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json(CANDIDATES_TRUNCATED));
  });
  await openTemplate(page, 'epic-optionsquery');
  const modal = page.getByTestId('template-modal');

  await expect(
    modal.locator('[data-testid="template-var-options-truncated"][data-var="プロジェクト名"]'),
  ).toBeVisible({ timeout: 5_000 });
});

// ---- /api/options-query エラー時フォールバック ----

test('[MOCK] /api/options-query 500 エラー → フォールバック自由入力 (モーダルは壊れない)', async ({
  page,
}) => {
  await boot(page, [EPIC_TEMPLATE_WITH_OPTIONSQUERY]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json({ error: 'internal_error', message: 'server error' }, 500));
  });
  await openTemplate(page, 'epic-optionsquery');
  const modal = page.getByTestId('template-modal');

  // エラー時: モーダルは開いたまま、フォールバック入力が使える
  await expect(modal).toBeVisible();
  const inputEl = modal.locator('[data-testid="template-var-input"][data-var="プロジェクト名"]');
  await expect(inputEl).toBeVisible({ timeout: 5_000 });
});

// ---- AC-S1bd397-4-4: モバイルレスポンシブ (mock) ----

test('[AC-S1bd397-4-4][MOCK] モバイル (390px) で TemplateModal が崩れない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, [EPIC_TEMPLATE_WITH_OPTIONSQUERY]);
  await page.route('**/api/options-query', (route) => {
    void route.fulfill(json(CANDIDATES_LOAMIUM_WEBAPP));
  });
  await openTemplate(page, 'epic-optionsquery');
  const modal = page.getByTestId('template-modal');

  // モーダルが viewport 内に収まる
  await expect(modal).toBeVisible();
  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.width).toBeLessThanOrEqual(390);
  }

  // 作成ボタンのタップターゲット >= 44px
  const createBtn = modal.getByTestId('template-create');
  const btnBox = await createBtn.boundingBox();
  expect(btnBox).not.toBeNull();
  if (btnBox !== null) {
    expect(btnBox.height).toBeGreaterThanOrEqual(44);
  }
});
