/**
 * Story S45fa45-2「本文のタグ入力と # 判定」E2E 受け入れテスト
 * ([AC-S45fa45-2-1] 見出し vs タグ判定 / [AC-S45fa45-2-2] 本文タグ補完 + ナビ)。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * 実操作 (キーボード入力) で `# 見出し` が H1、`#tag` がタグ装飾になること、
 * 本文 `#` の候補メニュー (S45fa45-1 と同一ソース) で確定でき、確定タグのクリックで
 * タグ検索へ遷移すること、ファイルは標準的な `#tag`(ピュア Markdown)のままを検証。
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

test('[AC-S45fa45-2-1] 本文で `# `=H1見出し、`#tag`(スペース無し)=タグ装飾になる', async ({ page }) => {
  await putNote('bt/judge.md', '作業メモ。\n');
  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="bt/judge.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('作業メモ');

  const line = editorLine(page, '作業メモ');
  await line.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# 見出しテスト');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('本文 #realtag');
  await page.keyboard.type(' です'); // 直後スペースでタグ入力を確定 (メニューを閉じる)

  // カーソルを中立行 (作業メモ) へ移し、見出し行・タグ行を装飾表示させる
  await editorLine(page, '作業メモ').click();

  // `# 見出しテスト` は H1 見出し (スペースあり)
  await expect(page.locator('.cm-md-h1')).toContainText('見出しテスト');
  // `#realtag` はタグチップ (スペース無し)。見出しにはならない
  const tag = page.locator('[data-testid="body-tag"][data-tag="realtag"]');
  await expect(tag).toBeVisible();
  await expect(tag).toHaveText('#realtag');

  // 保存 → ファイルはピュア Markdown (# 見出し / #realtag のまま)
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const file = await readVaultFile('bt/judge.md');
  expect(file).toContain('# 見出しテスト');
  expect(file).toContain('#realtag');
});

test('[AC-S45fa45-2-2] 本文 `#` の候補メニューで確定でき、タグクリックで検索へ遷移する', async ({
  page,
}) => {
  // 既存タグをインデックスへ (この spec 専用の一意な名前 bodysci:2)
  await putNote('bt-seeds/a.md', 'x #bodysci #bodybook\n');
  await putNote('bt-seeds/b.md', 'y #bodysci\n');
  await putNote('bt/complete.md', '本文開始。\n2 行目。\n');
  await expect.poll(() => tagCount('bodysci')).toBe(2);

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="bt/complete.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('本文開始');

  // 1 行目末尾で ` #bodys` を入力 → 候補メニュー (同一ソース)
  await editorLine(page, '本文開始').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' #bodys');
  const menu = page.getByTestId('tag-suggest-menu');
  await expect(menu).toBeVisible();
  const opt = menu.locator('[data-testid="tag-suggest-option"][data-tag="bodysci"]');
  await expect(opt).toBeVisible();
  await expect(opt.locator('.cnt')).toHaveText('2');
  await opt.click();

  // カーソルを 2 行目へ移すと 1 行目の確定タグが装飾される
  await editorLine(page, '2 行目').click();
  const chip = page.locator('[data-testid="body-tag"][data-tag="bodysci"]');
  await expect(chip).toBeVisible();

  // 保存 → ファイルは標準の `#bodysci` (ピュア Markdown)
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await readVaultFile('bt/complete.md')).toContain('#bodysci');

  // タグクリックでタグ絞り込み検索へ遷移する
  await chip.click();
  await expect.poll(() => page.url()).toContain('tag=bodysci');
});
