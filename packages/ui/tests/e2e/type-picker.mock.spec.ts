/**
 * Story S87f4b7-3 mock テスト (型ピッカーの絞り込み・混在提示・キーボード)。
 * page.route で /api/property-types を差し替え、内蔵 + JSON定義の混在提示や
 * インクリメンタル絞り込み・空状態を実ブラウザで固める。受け入れ本検証
 * (実ファイル追加) は type-picker.e2e.spec.ts。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-06';
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

async function openWithPicker(page: Page, typesBody: unknown): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  const content = ['---', 'status: x', '---', '', 'アンカー行。', ''].join('\n');
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.route('**/api/notes/journals/**', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.route('**/api/property-types', (route) => {
    void route.fulfill(json({ types: typesBody }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
  await page.getByTestId('properties-add').click();
  await expect(page.getByTestId('property-type-picker')).toBeVisible();
  return unexpected;
}

test('[MOCK] 型ピッカーがインクリメンタルに絞り込み、Esc で閉じる', async ({ page }) => {
  const unexpected = await openWithPicker(page, {});
  const picker = page.getByTestId('property-type-picker');
  const filter = page.getByTestId('property-type-filter');
  await expect(filter).toBeFocused();

  await filter.fill('date');
  await expect(picker.locator('[data-testid="property-type-option"]')).toHaveCount(1);
  await expect(picker.locator('[data-testid="property-type-option"][data-type="date"]')).toBeVisible();

  await filter.fill('');
  await expect(
    picker.locator('[data-testid="property-type-option"]').first(),
  ).toBeVisible();

  await filter.fill('絶対に無い型');
  await expect(picker.locator('.type-picker-empty')).toBeVisible();

  await filter.press('Escape');
  await expect(picker).toBeHidden();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 内蔵型 + JSON定義型が混在提示され、JSON定義はバッジで区別される', async ({ page }) => {
  const unexpected = await openWithPicker(page, {
    優先度: { type: 'select', options: ['高', '低'] },
  });
  const picker = page.getByTestId('property-type-picker');
  await expect(
    picker.locator('[data-testid="property-type-option"][data-source="builtin"]').first(),
  ).toBeVisible();
  const jsonOpt = picker.locator(
    '[data-testid="property-type-option"][data-source="json"][data-type="優先度"]',
  );
  await expect(jsonOpt).toBeVisible();
  await expect(jsonOpt.locator('.json-badge')).toBeVisible();

  // キーボード: ↓ で選択移動 → Enter で選ぶ (型→キー入力へ)
  const filter = page.getByTestId('property-type-filter');
  await filter.fill('優先');
  await filter.press('ArrowDown');
  await filter.press('Enter');
  await expect(page.getByTestId('properties-new-key')).toHaveValue('優先度');
  expect(unexpected).toEqual([]);
});
