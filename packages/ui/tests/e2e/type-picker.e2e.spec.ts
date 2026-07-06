/**
 * Story S87f4b7-3「プロパティ追加の型ピッカー」E2E 受け入れテスト (AC-3-1 / 3-2)。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * 型ピッカーのインクリメンタル絞り込み、内蔵型 + JSON定義型の混在提示、
 * 型選択→キー名→値 の追加フローで標準 YAML の新プロパティが増えることを検証。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function writeTypeDefs(defs: unknown): Promise<void> {
  const dir = path.join(state().vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'property-types.json'), JSON.stringify(defs), 'utf8');
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

async function openExpanded(page: Page, rel: string): Promise<void> {
  await page.goto(state().uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
}

test('[AC-S87f4b7-3-1] 追加ボタンで型候補メニューが開き、入力でインクリメンタルに絞れる', async ({
  page,
}) => {
  await putNote('picker/filter.md', ['---', 'status: x', '---', '', 'アンカー行。', ''].join('\n'));
  await openExpanded(page, 'picker/filter.md');

  await page.getByTestId('properties-add').click();
  const picker = page.getByTestId('property-type-picker');
  await expect(picker).toBeVisible();
  const filter = page.getByTestId('property-type-filter');
  await expect(filter).toBeFocused();

  // 全内蔵型が並ぶ
  await expect(picker.locator('[data-testid="property-type-option"][data-type="select"]')).toBeVisible();
  await expect(picker.locator('[data-testid="property-type-option"][data-type="date"]')).toBeVisible();

  // `s` で select / star / tags 等に絞られ、date は消える
  await filter.fill('s');
  await expect(picker.locator('[data-testid="property-type-option"][data-type="select"]')).toBeVisible();
  await expect(picker.locator('[data-testid="property-type-option"][data-type="star"]')).toBeVisible();
  await expect(picker.locator('[data-testid="property-type-option"][data-type="date"]')).toHaveCount(0);

  // さらに `star` まで打つと star だけになる
  await filter.fill('star');
  await expect(picker.locator('[data-testid="property-type-option"]')).toHaveCount(1);
  await expect(picker.locator('[data-testid="property-type-option"][data-type="star"]')).toBeVisible();

  // 一致なしの語で empty state
  await filter.fill('zzzznope');
  await expect(picker.locator('[data-testid="property-type-option"]')).toHaveCount(0);
  await expect(picker.locator('.type-picker-empty')).toBeVisible();

  // Esc で閉じる
  await filter.press('Escape');
  await expect(picker).toBeHidden();
});

test('[AC-S87f4b7-3-2] 内蔵型 + JSON定義型が混在提示され、型→キー→値で標準 YAML が追加される', async ({
  page,
}) => {
  await writeTypeDefs({
    優先度: {
      type: 'select',
      options: [
        { value: '高', color: 'red' },
        { value: '中', color: 'amber' },
        { value: '低', color: 'blue' },
      ],
    },
    難易度: { type: 'star' },
  });
  await putNote('picker/add.md', ['---', 'status: x', '---', '', 'アンカー行。', ''].join('\n'));
  await openExpanded(page, 'picker/add.md');

  await page.getByTestId('properties-add').click();
  const picker = page.getByTestId('property-type-picker');
  await expect(picker).toBeVisible();

  // 内蔵型 (source=builtin) と JSON定義型 (source=json) の両方が並ぶ
  await expect(
    picker.locator('[data-testid="property-type-option"][data-source="builtin"][data-type="text"]'),
  ).toBeVisible();
  const jsonOpt = picker.locator(
    '[data-testid="property-type-option"][data-source="json"][data-type="優先度"]',
  );
  await expect(jsonOpt).toBeVisible();
  // JSON定義型は区別表示 (バッジ)
  await expect(jsonOpt.locator('.json-badge')).toBeVisible();
  await expect(
    picker.locator('[data-testid="property-type-option"][data-source="json"][data-type="難易度"]'),
  ).toBeVisible();

  // JSON定義型「優先度」を選ぶ → キー名は事前入力され、値を入れて追加
  await jsonOpt.click();
  const keyInput = page.getByTestId('properties-new-key');
  await expect(keyInput).toHaveValue('優先度');
  await page.getByTestId('properties-new-value').fill('高');
  await page.keyboard.press('Enter');
  const newRow = page.locator('[data-testid="properties-row"][data-key="優先度"]');
  await expect(newRow).toBeVisible();
  // JSON定義の select として色付き描画される
  await expect(newRow.locator('[data-type="select"]')).toHaveAttribute('data-color', 'red');

  await editorLine(page, 'アンカー行').click();
  await save(page);
  const file = await readVaultFile('picker/add.md');
  expect(file).toContain('優先度: 高'); // 標準 YAML の文字列スカラー
  expect(file).toContain('status: x');
  expect(file).not.toContain('type:'); // 型情報はファイルに書かない
});
