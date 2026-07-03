/**
 * Story S6fbf45-1「[[リンク]] オートコンプリート」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { journalPath, todayJournalDate } from '@loamium/shared';
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

test('[AC-S6fbf45-1-1] [[ 入力で既存ノート名の候補が出て部分一致で絞り込まれ、選択で [[ノート名]] が挿入される', async ({ page }) => {
  const today = todayJournalDate();
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('journal-today')).toContainText(today);

  // 末尾で [[ を入力 → 候補ポップアップが開く (既存ノート名)
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nリンク検証: [[');
  await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();
  const options = page.getByTestId('wikilink-autocomplete-option');
  await expect(options.first()).toBeVisible();

  // 部分一致絞り込み: "Code" → CodeMirror 6 調査 だけが残る
  await page.keyboard.type('Code');
  await expect(
    page.locator('[data-testid="wikilink-autocomplete-option"][data-note="CodeMirror 6 調査.md"]'),
  ).toBeVisible();
  await expect(options).toHaveCount(1);
  // 一致しないノート (Hydra 設計メモ) は候補から消えている
  await expect(
    page.locator('[data-testid="wikilink-autocomplete-option"][data-note="projects/Hydra 設計メモ.md"]'),
  ).toHaveCount(0);

  // Enter で [[CodeMirror 6 調査]] が挿入される
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('wikilink-autocomplete')).toHaveCount(0);
  await expect(editorLine(page, 'リンク検証:')).toContainText('[[CodeMirror 6 調査]]');

  // 保存されるとファイルにはピュア Markdown の [[リンク]] だけが書かれている
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const journalFile = await readFile(path.join(state().vault, journalPath(today)), 'utf8');
  expect(journalFile).toContain('リンク検証: [[CodeMirror 6 調査]]');
});

test('[AC-S6fbf45-1-2] 存在しないノートへのリンクは壊れリンク表示 (赤+破線) になり、クリックで新規ノートが作成される', async ({ page }) => {
  const source = 'wikilink-broken-e2e.md';
  await putNote(source, '計画は [[Tauri 移行計画]] にまとめる。\n\nアンカー行。\n');
  await openNoteFromTree(page, source, 'アンカー行');
  await editorLine(page, 'アンカー行').click();

  // 壊れリンクとして視覚的に区別される (wikilink-broken testid + 破線下線)
  const broken = page.getByTestId('wikilink-broken');
  await expect(broken).toBeVisible();
  await expect(broken).toHaveAttribute('data-target', 'Tauri 移行計画.md');
  await expect(broken).toHaveClass(/broken/);
  const deco = await broken.evaluate((el) => {
    const style = getComputedStyle(el);
    return { line: style.textDecorationLine, style: style.textDecorationStyle, color: style.color };
  });
  expect(deco.line).toContain('underline');
  expect(deco.style).toBe('dashed');
  // 解決済みリンクとは色が異なる (赤系 --danger: #d64545)
  expect(deco.color).toBe('rgb(214, 69, 69)');

  // クリックで新規ノートが作成されて開く
  await broken.click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('Tauri 移行計画');
  const createdFile = path.join(state().vault, 'Tauri 移行計画.md');
  expect((await stat(createdFile)).isFile()).toBe(true);
  // ツリーにも新規ノートが現れる
  await expect(page.locator('[data-testid="tree-item"][data-path="Tauri 移行計画.md"]')).toBeVisible();

  // 元ノートに戻ると、同じリンクは解決済み (壊れリンクではない) になっている
  await page.locator(`[data-testid="tree-item"][data-path="${source}"]`).click();
  await editorLine(page, 'アンカー行').click();
  await expect(page.locator('[data-testid="wikilink"][data-target="Tauri 移行計画.md"]')).toBeVisible();
  await expect(page.getByTestId('wikilink-broken')).toHaveCount(0);
});

test('[AC-S6fbf45-1-3] [[リンク]] のクリック (または Cmd/Ctrl+クリック) でそのノートに移動できる', async ({ page }) => {
  const source = 'wikilink-nav-e2e.md';
  await putNote(source, '参照: [[Hydra 設計メモ]] と [[Hydra 設計メモ|別名リンク]]。\n\nアンカー行。\n');
  await openNoteFromTree(page, source, 'アンカー行');
  await editorLine(page, 'アンカー行').click();

  // プレーンクリックで対象ノートへ移動
  const link = page.locator('[data-testid="wikilink"][data-target="projects/Hydra 設計メモ.md"]');
  await expect(link).toHaveCount(2);
  await link.first().click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('Hydra 設計メモ');
  await expect(page.getByTestId('editor')).toContainText('自宅サーバーの再構成メモ');

  // 戻って Cmd/Ctrl+クリック (エイリアス表示のリンク) でも移動できる
  await page.locator(`[data-testid="tree-item"][data-path="${source}"]`).click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('wikilink-nav-e2e');
  await editorLine(page, 'アンカー行').click();
  const alias = page.locator('[data-testid="wikilink"][data-target="projects/Hydra 設計メモ.md"]', {
    hasText: '別名リンク',
  });
  await alias.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.breadcrumb .current')).toHaveText('Hydra 設計メモ');

  // ナビゲーションでファイルは変更されない (ピュア Markdown 不変)
  const sourceFile = await readFile(path.join(state().vault, source), 'utf8');
  expect(sourceFile).toBe('参照: [[Hydra 設計メモ]] と [[Hydra 設計メモ|別名リンク]]。\n\nアンカー行。\n');
});
