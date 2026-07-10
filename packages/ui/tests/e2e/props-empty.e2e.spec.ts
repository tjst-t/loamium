/**
 * Story Sd13ab1-3「空ノートへの追加入口」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * ビジュアルの正は prototype/props-redesign/chosen-v2.html (E 欄)。
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

async function openNoteFromTree(page: Page, rel: string, waitText: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
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

test('[AC-Sd13ab1-3-2] frontmatter 無しノートに追加入口が出て、押すと最初のプロパティを作成できる', async ({
  page,
}) => {
  await putNote('empty/none.md', '# 週次メモ\n\n本文のみ。\n');
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'empty/none.md', '本文のみ');

  // frontmatter が無いので frontmatter widget は無い。控えめな追加入口が出る
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  const emptyAdd = page.getByTestId('properties-empty-add');
  await expect(emptyAdd).toBeVisible();

  // 押すとキーファーストメニューが開く (Sd13ab1-2 と同じ)
  await emptyAdd.click();
  await expect(page.getByTestId('property-add-menu')).toBeVisible();

  // 最初のプロパティに status を選ぶ → frontmatter (--- ブロック) が生成される
  await page.getByTestId('property-add-filter').fill('status');
  await page.locator('[data-testid="property-add-known"][data-key="status"]').click();
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  // 空ノートへの初回追加時は詳細が自動で開き、すぐ値を入力できる (fix: 自動展開)
  await expect(widget).toHaveAttribute('data-open', 'true');
  await expect(widget.locator('[data-testid="properties-row"][data-key="status"]')).toBeVisible();

  await editorLine(page, '本文のみ').click();
  await save(page);
  const file = await readVaultFile('empty/none.md');
  // 標準 YAML frontmatter が先頭に生成され、本文は保たれる (ピュア Markdown)
  expect(file.startsWith('---\n')).toBe(true);
  expect(file).toContain('status:');
  expect(file).toContain('本文のみ。');
  expect(file).toContain('# 週次メモ');
});
