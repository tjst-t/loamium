/**
 * Story S45fa45-1「タグ候補補完(共通ソース)」E2E 受け入れテスト ([AC-S45fa45-1-1])。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * 候補ソースは GET /api/tags (実インデックス)。tags プロパティ値で `#` を打つと
 * 既存タグ候補(件数付き)が出てインクリメンタルに絞り込め、選択でチップが増え、
 * 保存で標準 YAML(ピュア Markdown)として書き戻ることを検証する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const encoded = rel.split('/').map((s) => encodeURIComponent(s)).join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function tagCount(tag: string): Promise<number> {
  const res = await fetch(`${state().apiUrl}/api/tags`);
  const body = (await res.json()) as { tags: { tag: string; count: number }[] };
  return body.tags.find((t) => t.tag === tag)?.count ?? 0;
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

test('[AC-S45fa45-1-1] tags 値の # で件数付き候補 → 絞り込み → 選択でチップ追加、標準 YAML で保存', async ({
  page,
}) => {
  // 既存タグをインデックスへ積む (この spec 専用の一意な名前で他テストと混ざらないように)。
  // propbook:3 / propboard:1 / propcat:1
  await putNote('ts-seeds/s1.md', 'a #propbook #propcat\n');
  await putNote('ts-seeds/s2.md', 'b #propbook #propboard\n');
  await putNote('ts-seeds/s3.md', 'c #propbook\n');
  await putNote('ts-prop/note.md', ['---', 'tags: [alpha]', '---', '', 'アンカー行。', ''].join('\n'));
  // ファイル監視によるインデックス反映を待つ (件数が揃ってから UI を開く)
  await expect.poll(() => tagCount('propbook')).toBe(3);

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="ts-prop/note.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');

  const input = page.getByTestId('properties-chip-input');
  await input.click();
  await input.pressSequentially('#');
  const menu = page.getByTestId('tag-suggest-menu');
  await expect(menu).toBeVisible();
  // 件数付き既存タグが出る (件数降順: propbook が先頭)
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="propbook"] .cnt')).toHaveText('3');

  // `propbo` でインクリメンタル絞り込み → propbook / propboard、propcat は消える
  await input.pressSequentially('propbo');
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="propbook"]')).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="propboard"]')).toBeVisible();
  await expect(menu.locator('[data-testid="tag-suggest-option"][data-tag="propcat"]')).toHaveCount(0);
  // 末尾に「新規作成: #propbo」
  await expect(menu.locator('.tag-opt.create-new[data-tag="propbo"]')).toContainText('新規作成: #propbo');

  // propbook を選択 → チップが追加される
  await menu.locator('[data-testid="tag-suggest-option"][data-tag="propbook"]').click();
  await expect(widget.locator('[data-testid="properties-chip"][data-value="propbook"]')).toBeVisible();

  // 保存 → 標準 YAML の配列 (# なし、ピュア Markdown)
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile('ts-prop/note.md');
  expect(file).toContain('alpha');
  expect(file).toContain('propbook');
  expect(file).toMatch(/tags:/);
  expect(file).not.toContain('#propbook'); // frontmatter に # は書かない
});

test('[AC-S45fa45-1-1] 新規作成候補で未知のタグを追加できる', async ({ page }) => {
  await putNote('ts-new/note.md', ['---', 'tags: []', '---', '', 'アンカー行。', ''].join('\n'));
  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="ts-new/note.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');

  const input = page.getByTestId('properties-chip-input');
  await input.click();
  await input.pressSequentially('#brandnewtag');
  const menu = page.getByTestId('tag-suggest-menu');
  await menu.locator('.tag-opt.create-new[data-tag="brandnewtag"]').click();
  await expect(widget.locator('[data-testid="properties-chip"][data-value="brandnewtag"]')).toBeVisible();

  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile('ts-new/note.md');
  expect(file).toContain('brandnewtag');
});
