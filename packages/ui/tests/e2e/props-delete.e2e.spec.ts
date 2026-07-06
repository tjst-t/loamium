/**
 * Story Sd13ab1-3「行削除UI」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * ビジュアルの正は prototype/props-redesign/chosen-v2.html (B 欄・行ホバーの ×)。
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

async function expand(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  if ((await widget.getAttribute('data-open')) !== 'true') {
    await widget.getByTestId('properties-summary').click();
    await expect(widget).toHaveAttribute('data-open', 'true');
  }
}

test('[AC-Sd13ab1-3-1] 各行の × でその行(キー)を削除でき、標準 YAML に反映される', async ({
  page,
}) => {
  await putNote(
    'del/rows.md',
    ['---', 'tags: [a]', 'status: 読了', 'rating: 4', '---', '', 'アンカー行。', ''].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'del/rows.md', 'アンカー行');
  await expand(page);

  // status 行の削除アフォーダンス (properties-row-delete[data-key=status])
  const statusRow = page.locator('[data-testid="properties-row"][data-key="status"]');
  await statusRow.hover();
  await statusRow.locator('[data-testid="properties-row-delete"]').click();
  await expect(statusRow).toHaveCount(0);

  await editorLine(page, 'アンカー行').click();
  await save(page);
  const file = await readVaultFile('del/rows.md');
  // status は消え、他のキーは残る。標準 YAML frontmatter のまま
  expect(file).not.toContain('status:');
  expect(file).toContain('rating: 4');
  expect(file).toContain('tags:');
  expect(file.startsWith('---\n')).toBe(true);
});

test('[AC-Sd13ab1-3-1] 全プロパティを削除すると --- ブロックごと除去される', async ({ page }) => {
  await putNote(
    'del/all.md',
    ['---', 'status: x', 'rating: 2', '---', '', 'アンカー行。', ''].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'del/all.md', 'アンカー行');
  await expand(page);

  // すべての行を削除
  while ((await page.locator('[data-testid="properties-row-delete"]').count()) > 0) {
    await page.locator('[data-testid="properties-row-delete"]').first().click();
  }
  // frontmatter widget は消え、frontmatter 無しの入口に戻る
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('properties-empty-add')).toBeVisible();

  await editorLine(page, 'アンカー行').click();
  await save(page);
  const file = await readVaultFile('del/all.md');
  // --- ブロックごと除去され、本文だけが残る
  expect(file).not.toContain('---');
  expect(file).toContain('アンカー行。');
});
