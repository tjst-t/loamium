/**
 * Story S87f4b7-2「意味型システム(D方式)と型別描画」E2E 受け入れテスト (AC-2-2)。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * 意味型ごとのリッチ描画・編集を実ブラウザで確認し、編集結果が実ファイルで
 * 標準 YAML スカラー(star/progress→数値・checkbox→真偽・select→文字列・
 * tags→フラット配列)になっていることを検証する。型情報はファイルに書かない。
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

function expectCleanMarkdown(file: string): void {
  // eslint-disable-next-line no-control-regex
  expect(file).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  expect(file).not.toMatch(/\^[A-Za-z0-9]{6}/);
  expect(file).not.toContain('id::');
  expect(file).not.toContain('type:');
}

const TYPED_NOTE = [
  '---',
  'tags: [sample-book, science]',
  'status: 読了',
  'rating: 2',
  '優先度: 低',
  'progress: 80',
  '再読したい: true',
  'created: 2026-05-20',
  '参考: https://example.com',
  '関連: "[[失敗学入門]]"',
  'ページ数: 336',
  '著者: マシュー・サイド',
  '---',
  '',
  'アンカー行。',
  '',
].join('\n');

test('[AC-S87f4b7-2-2] 意味型ごとにリッチ描画・編集でき、結果が標準 YAML スカラーで書き戻る', async ({
  page,
}) => {
  // JSON定義: 優先度 = select(高/中/低・色つき)
  await writeTypeDefs({
    優先度: {
      type: 'select',
      options: [
        { value: '高', color: 'red' },
        { value: '中', color: 'amber' },
        { value: '低', color: 'blue' },
      ],
    },
  });
  await putNote('types/typed.md', TYPED_NOTE);
  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="types/typed.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');

  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');

  const row = (key: string) =>
    widget.locator(`[data-testid="properties-row"][data-key="${key}"]`);

  // ---- 型別の描画確認 ----
  await expect(row('rating').locator('[data-type="star"]')).toBeVisible();
  await expect(row('rating').locator('.pc-star')).toHaveCount(5);
  await expect(row('progress').locator('[data-type="progress"]')).toHaveAttribute('data-value', '80');
  await expect(row('progress').locator('.pc-progress .bar > i')).toBeVisible();
  await expect(row('status').locator('[data-type="select"]')).toContainText('読了');
  // JSON定義の select は options の色を反映
  await expect(row('優先度').locator('[data-type="select"]')).toHaveAttribute('data-color', 'blue');
  await expect(row('再読したい').getByTestId('properties-bool')).toBeChecked();
  await expect(row('created').locator('[data-type="date"]')).toContainText('2026-05-20');
  await expect(row('参考').locator('[data-type="url"]')).toContainText('example.com');
  await expect(row('関連').locator('[data-type="note-link"]')).toHaveAttribute(
    'data-target',
    '失敗学入門',
  );
  await expect(row('ページ数').locator('[data-type="number"]')).toContainText('336');
  await expect(row('著者').locator('[data-type="text"]')).toContainText('マシュー・サイド');
  // tags はチップ
  await expect(row('tags').getByTestId('properties-chip')).toHaveCount(2);

  // ---- star: クリックで増減 (4 個目の星 → rating=4) ----
  await row('rating').locator('.pc-star[data-index="4"]').click();
  await expect(row('rating').locator('[data-type="star"]')).toHaveAttribute('data-value', '4');

  // ---- checkbox: クリックで真偽切替 (true → false) ----
  await row('再読したい').getByTestId('properties-bool').click();
  await expect(row('再読したい').getByTestId('properties-bool')).not.toBeChecked();

  // ---- select(JSON options): 選択肢メニューから '高' を選ぶ ----
  await row('優先度').locator('[data-type="select"]').click();
  await expect(page.getByTestId('properties-select-menu')).toBeVisible();
  await page.locator('[data-testid="properties-select-option"][data-value="高"]').click();
  await expect(row('優先度').locator('[data-type="select"]')).toContainText('高');

  // ---- progress: クリックで数値入力 → 55 ----
  await row('progress').locator('[data-type="progress"]').click();
  const pInput = page.getByTestId('properties-value-input');
  await expect(pInput).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('55');
  await page.keyboard.press('Enter');
  await expect(row('progress').locator('[data-type="progress"]')).toHaveAttribute('data-value', '55');

  // ---- 保存 → 実ファイルは標準 YAML スカラー ----
  await editorLine(page, 'アンカー行').click();
  await save(page);
  const file = await readVaultFile('types/typed.md');
  expect(file).toContain('rating: 4'); // star → 数値
  expect(file).toContain('再読したい: false'); // checkbox → 真偽
  expect(file).toContain('優先度: 高'); // select → 文字列
  expect(file).toContain('progress: 55'); // progress → 0-100 数値
  // tags は未編集のため原文 verbatim (フロー形式のフラット配列 = 標準 YAML)
  expect(file).toContain('tags: [sample-book, science]');
  // 未編集キーは保たれる
  expect(file).toContain('ページ数: 336');
  expect(file).toContain('著者: マシュー・サイド');
  expect(file).toContain('参考: https://example.com');
  expect(file).toContain('関連: "[[失敗学入門]]"');
  expect(file).toContain('アンカー行。');
  expectCleanMarkdown(file);
});
