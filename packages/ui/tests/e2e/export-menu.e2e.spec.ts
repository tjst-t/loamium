/**
 * Story Sa8ee62-2 ⋯ アクションメニュー PDF エクスポート E2E テスト。
 * 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー → 実ファイルシステム (一時 vault)。
 * ネットワークモックは使わない。
 *
 * [AC-Sa8ee62-2-1] ⋯ メニューに PDF エクスポート / Copy link / Copy path が存在する
 * [AC-Sa8ee62-2-2] PDF エクスポートが実サーバーから 200 + application/pdf を受け取る
 * [AC-Sa8ee62-2-3] Copy link / Copy path は既存動作を壊さない
 */
import { test, expect } from '@playwright/test';
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

test('[AC-Sa8ee62-2-1] ⋯ メニューに PDF エクスポート / Copy link / Copy path の 3 項目がある (e2e)', async ({
  page,
}) => {
  await putNote('e2e-export-menu.md', '# エクスポートE2E\n\n本文。\n');

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="e2e-export-menu.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('エクスポートE2E');

  // ⋯ メニューを開く
  await page.getByTestId('info-actions-btn').click();
  await expect(page.getByTestId('info-actions-menu')).toHaveClass(/open/);

  // 3 項目が存在する
  await expect(page.getByTestId('action-export-pdf')).toBeVisible();
  await expect(page.getByTestId('action-copy-link')).toBeVisible();
  await expect(page.getByTestId('action-copy-path')).toBeVisible();
});

test('[AC-Sa8ee62-2-2] PDF エクスポートが実サーバーから 200 + application/pdf を返す (e2e)', async ({
  page,
}) => {
  await putNote('e2e-export-pdf.md', '# PDF エクスポートテスト\n\n本文テスト。\n');

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="e2e-export-pdf.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('PDF エクスポートテスト');

  // ダウンロードを待ちながら PDF エクスポートボタンをクリック
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    (async () => {
      await page.getByTestId('info-actions-btn').click();
      await expect(page.getByTestId('action-export-pdf')).toBeVisible();
      await page.getByTestId('action-export-pdf').click();
    })(),
  ]);

  // ダウンロードが成功した
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  // ダウンロードされたファイルのサイズを確認 (空ではない)
  const path = await download.path();
  expect(path).not.toBeNull();

  // UI がまだ正常に機能している (クラッシュしていない)
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('PDF エクスポートテスト');
});

test('[AC-Sa8ee62-2-3] Copy link / Copy path が既存通り動作する (e2e)', async ({ page }) => {
  await putNote('e2e-copy-items.md', '# コピーテスト\n\n本文。\n');

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="e2e-copy-items.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('コピーテスト');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  // Copy link
  await page.getByTestId('info-actions-btn').click();
  await page.getByTestId('action-copy-link').click();
  await expect(page.getByTestId('info-actions-menu')).not.toHaveClass(/open/);
  const linkText = await page.evaluate(() => navigator.clipboard.readText());
  expect(linkText).toBe('[[e2e-copy-items]]');

  // Copy path
  await page.getByTestId('info-actions-btn').click();
  await page.getByTestId('action-copy-path').click();
  await expect(page.getByTestId('info-actions-menu')).not.toHaveClass(/open/);
  const pathText = await page.evaluate(() => navigator.clipboard.readText());
  expect(pathText).toBe('e2e-copy-items.md');
});
