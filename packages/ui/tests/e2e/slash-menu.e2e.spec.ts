/**
 * Story S763a98-1「スラッシュコマンドメニュー (/ 挿入)」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 *
 * 挿入結果が「ピュア Markdown としてファイルに載る」ことまで実ファイル読取で検証する
 * (DESIGN_PRINCIPLES priority 1)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openNoteFromTree(page: Page, rel: string, waitText: string): Promise<void> {
  await page.goto(state().uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
}

test('[AC-S763a98-1-1] 行頭で / を入力するとメニューが開き、入力で絞り込め、↑↓/Enter・Esc で操作できる', async ({ page }) => {
  const source = 'slash-open-e2e.md';
  await putNote(source, '# スラッシュ検証\n\nアンカー行。\n');
  await openNoteFromTree(page, source, 'アンカー行');

  // 空行を作って行頭で / を打つ → メニューが開く (AC: 行頭または空白後)
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('slash-item')).toHaveCount(8);

  // 入力で絞り込み: "call" → callout のみ (タイトル一致で mark)
  await page.keyboard.type('call');
  await expect(page.getByTestId('slash-item')).toHaveCount(1);
  const callout = page.locator('[data-testid="slash-item"][data-command="callout"]');
  await expect(callout).toBeVisible();
  await expect(callout.locator('mark')).toHaveText('call');

  // Esc で閉じる
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // 直前の "/call" を消してから打ち直し、↑↓ ナビ + Enter で選択挿入する
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('/');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // table → callout
  await expect(page.locator('[data-testid="slash-item"][data-command="callout"]')).toHaveClass(/selected/);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('[!note]');
});

test('[AC-S763a98-1-2] 各コマンドが標準 Markdown で挿入され、カーソルが編集開始位置に置かれる', async ({ page }) => {
  const source = 'slash-insert-e2e.md';
  await putNote(source, '# 挿入検証\n\nアンカー行。\n');
  await openNoteFromTree(page, source, 'アンカー行');

  // テーブル挿入 → 標準 Markdown テーブル雛形、カーソルは先頭セル
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/table');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  // カーソルが先頭セル (| ▍見出し1) にある証拠: そのまま打つと先頭セルに入る
  await page.keyboard.type('セル');
  await expect(editorLine(page, 'セル見出し1')).toContainText('| セル見出し1 | 見出し2 | 見出し3 |');

  // 続けてチェックボックス挿入 (標準 - [ ])
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n/todo');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('牛乳を買う');
  await expect(editorLine(page, '牛乳を買う')).toContainText('- [ ] 牛乳を買う');

  // 保存 → ファイルにはピュア Markdown だけが載る (ブロック ID・独自記法なし)
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readFile(path.join(state().vault, source), 'utf8');
  expect(file).toContain('| セル見出し1 | 見出し2 | 見出し3 |');
  expect(file).toContain('| --- | --- | --- |');
  expect(file).toContain('- [ ] 牛乳を買う');
  // 独自記法・ブロック ID が紛れていないこと
  expect(file).not.toMatch(/\^[A-Za-z0-9]{6}/); // ^blockid
  expect(file).not.toContain('id::');
});

test('[AC-S763a98-1-3] コードフェンス内・インラインコード内では / メニューが発火しない', async ({ page }) => {
  const source = 'slash-suppress-e2e.md';
  const content = ['# 抑制検証', '', '```text', 'CODEBODY', '```', '', '設定は `a b` を使う。', '', 'アンカー行。', ''].join('\n');
  await putNote(source, content);
  await openNoteFromTree(page, source, 'アンカー行');

  // コードフェンス内: 行頭で / を打っても開かない
  await editorLine(page, 'CODEBODY').click();
  await page.keyboard.press('Home');
  await page.keyboard.type('/');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
  await page.keyboard.press('Backspace');

  // インラインコード内: コード内の空白直後で / を打っても開かない
  await editorLine(page, '設定は').click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('/');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);

  // 対照: コード外の行頭 / では正しく開く (抑制が過剰でないこと)
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
});
