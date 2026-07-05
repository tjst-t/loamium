/**
 * Story Seac77a-1 E2E 受け入れテスト (ファイル/フォルダブラウザ)。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム。ノート/添付を実 API で vault へ置き、実操作で検証する。
 *
 * - AC-Seac77a-1-2: ノートをクリック→エディタで開く / 非ノートはプレビュー /
 *   vault 相対パスをコピー / 削除 (確認あり・監査ログ記録) → 一覧に反映。
 * - AC-Seac77a-1-3: サイドバー「すべて表示」およびツリーのフォルダクリックから
 *   /files へ遷移でき、履歴 (戻る/進む) に積まれる。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

/** 1x1 の実 PNG (プレビュー・配信のため実バイト列)。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function encodePath(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodePath(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function uploadFile(rel: string, bytes: Buffer): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/files/${encodePath(rel)}?overwrite=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  expect(res.ok).toBe(true);
}

/** ルート (/) から /files へ遷移する (サイドバー「すべて表示」経由)。 */
async function gotoFilesViaShowAll(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('sidebar-show-all')).toBeVisible();
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId('files-list')).toBeVisible();
}

test('[AC-Seac77a-1-2] ノートはエディタで開き、添付はプレビュー・パスコピー・削除(監査ログ)できる', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  const notePath = 'seac77a-open/note-alpha.md';
  const pngPath = 'seac77a-open/pic.png';
  await putNote(notePath, '# Alpha E2E\n\n本文アルファE2E\n');
  await uploadFile(pngPath, PIXEL_PNG);

  await gotoFilesViaShowAll(page);
  await page.getByTestId('files-filter').fill('seac77a-open');

  const noteRow = page.locator(`[data-testid="file-row"][data-path="${notePath}"]`);
  const pngRow = page.locator(`[data-testid="file-row"][data-path="${pngPath}"]`);
  await expect(noteRow).toBeVisible();
  await expect(pngRow).toBeVisible();
  // 名前・種別・サイズ・更新日時が並ぶ (種別列)
  await expect(noteRow).toContainText('Markdown');
  await expect(pngRow).toContainText('PNG 画像');

  // --- 非ノートファイルはプレビューできる ---
  await pngRow.getByTestId('file-preview-btn').click();
  const pane = page.getByTestId('files-preview-pane');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText(pngPath);
  await expect(pane.getByTestId('embed-image')).toBeVisible();

  // --- vault 相対パス (![[...]]) をコピーできる ---
  await pngRow.getByTestId('file-copy-path').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`![[${pngPath}]]`);

  // --- 削除 (確認あり) → 一覧に反映 + 監査ログ記録 ---
  await pngRow.getByTestId('file-delete-btn').click();
  await expect(page.getByTestId('delete-dialog')).toContainText('ファイルを削除');
  await page.getByTestId('delete-confirm').click();
  await expect(pngRow).toHaveCount(0);
  // 実ファイルも消えている
  const gone = await fetch(`${state().apiUrl}/api/files/${encodePath(pngPath)}`);
  expect(gone.status).toBe(404);
  // 監査ログに file.delete が記録されている
  const auditRaw = await readFile(path.join(state().vault, '.loamium/audit.log'), 'utf8');
  const deleted = auditRaw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { op: string; path: string; result: string })
    .some((e) => e.op === 'file.delete' && e.path === pngPath && e.result === 'ok');
  expect(deleted).toBe(true);

  // --- ノートをクリックするとエディタで開く ---
  await noteRow.click();
  await expect(page).toHaveURL(/\/n\/seac77a-open\/note-alpha$/);
  await expect(page.getByTestId('editor')).toContainText('本文アルファE2E');
});

test('[AC-Seac77a-1-3] すべて表示・ツリーのフォルダから /files へ遷移でき履歴に積まれる', async ({
  page,
}) => {
  await putNote('seac77a-nav/deep-note.md', '# Deep\n\nナビゲーション用ノート\n');
  await putNote('seac77a-other/other-note.md', '# Other\n\n別フォルダ\n');

  // ルート (今日のジャーナル) から「すべて表示」で /files へ (遷移 #1)
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId('files-list')).toBeVisible();

  // 戻る → ジャーナル (履歴に積まれている)
  await page.getByTestId('nav-back').click();
  await expect(page).not.toHaveURL(/\/files$/);
  await expect(page.getByTestId('editor')).toBeVisible();

  // 進む → 再び /files
  await page.getByTestId('nav-forward').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId('files-list')).toBeVisible();

  // /files ページのツリー (files-tree) のフォルダクリックで表をそのフォルダへ絞り込む
  // (サイドバーのフォルダツリー (S79c210-1) と testid が同じため files-tree にスコープする)
  await page.locator('[data-testid="files-tree"] [data-testid="tree-folder"][data-path="seac77a-nav"]').click();
  await expect(
    page.locator('[data-testid="file-row"][data-path="seac77a-nav/deep-note.md"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="file-row"][data-path="seac77a-other/other-note.md"]'),
  ).toHaveCount(0);

  // /files からノートを開くと履歴に積まれ、戻ると /files に戻れる
  await page.locator('[data-testid="file-row"][data-path="seac77a-nav/deep-note.md"]').click();
  await expect(page).toHaveURL(/\/n\/seac77a-nav\/deep-note$/);
  await expect(page.getByTestId('editor')).toContainText('ナビゲーション用ノート');
  await page.getByTestId('nav-back').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId('files-list')).toBeVisible();
});
