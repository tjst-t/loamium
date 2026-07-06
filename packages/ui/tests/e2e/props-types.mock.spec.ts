/**
 * Story S87f4b7-2 mock テスト (意味型の描画・編集・フォールバック)。
 * page.route で /api/property-types を差し替え、内蔵ヒューリスティック描画・
 * JSON定義の上書き・壊れた定義でのフォールバックを実ブラウザで固める。
 * 受け入れ本検証 (実ファイル書込) は props-types.e2e.spec.ts。
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

async function open(page: Page, content: string, typesBody: unknown): Promise<string[]> {
  const unexpected = await installCatchAll(page);
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
  // 型定義を差し替え (最後勝ちで catch-all の既定 {} を上書き)
  await page.route('**/api/property-types', (route) => {
    void route.fulfill(json({ types: typesBody }));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  return unexpected;
}

const NOTE = [
  '---',
  'status: 読了',
  'rating: 3',
  'progress: 40',
  'done: true',
  '参考: https://example.com',
  '---',
  '',
  'アンカー行。',
  '',
].join('\n');

async function expand(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
}

test('[MOCK] 内蔵ヒューリスティックで型別描画される (JSON定義なし)', async ({ page }) => {
  const unexpected = await open(page, NOTE, {});
  await expand(page);
  const widget = page.getByTestId('properties-widget');
  const row = (k: string) => widget.locator(`[data-testid="properties-row"][data-key="${k}"]`);
  await expect(row('status').locator('[data-type="select"]')).toBeVisible();
  await expect(row('rating').locator('.pc-star')).toHaveCount(5);
  await expect(row('progress').locator('[data-type="progress"]')).toHaveAttribute('data-value', '40');
  await expect(row('done').getByTestId('properties-bool')).toBeChecked();
  await expect(row('参考').locator('[data-type="url"]')).toBeVisible();

  // star クリックで即座に data-value が変わる
  await row('rating').locator('.pc-star[data-index="5"]').click();
  await expect(row('rating').locator('[data-type="star"]')).toHaveAttribute('data-value', '5');
  expect(unexpected).toEqual([]);
});

test('[MOCK] JSON定義がヒューリスティックを上書きする (status→star)', async ({ page }) => {
  const unexpected = await open(page, NOTE, { status: { type: 'star' } });
  await expand(page);
  const widget = page.getByTestId('properties-widget');
  // status は本来 select だが JSON定義 star で上書き
  await expect(
    widget.locator('[data-testid="properties-row"][data-key="status"] .pc-star'),
  ).toHaveCount(5);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 壊れた型定義でもクラッシュせずヒューリスティックにフォールバック', async ({ page }) => {
  // 不正な型 (rainbow) や配列など。UI 側 parsePropertyTypesJson が弾く。
  const unexpected = await open(page, NOTE, { status: { type: 'rainbow' }, x: [1, 2] });
  await expand(page);
  const widget = page.getByTestId('properties-widget');
  // status は無効定義 → ヒューリスティック (select) にフォールバック
  await expect(
    widget.locator('[data-testid="properties-row"][data-key="status"] [data-type="select"]'),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
});
