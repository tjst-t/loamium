/**
 * 物理ツリー差分更新の latency acceptance テスト (Sd5c9f4-5 / AC-Sd5c9f4-5-4)。
 *
 * 外部から PUT /api/notes で新規ノートを作成したとき、
 * SSE notes_changed → App.tsx 差分更新 → 物理サイドバーにファイルが現れることを確認する。
 *
 * タイムアウトを 2000ms に設定する理由:
 *   - 1s ガード (AC-Sd5c9f4-5-5) + chokidar awaitWriteFinish 150ms + マージン
 *   - CI フレークを避けるために 2 秒の余裕を持たせる (AC-Sd5c9f4-5-5 注記)
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実ファイルシステム。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();
const ROOT = 'sse-latency-e2e';

function encodePath(rel: string): string {
  return rel.split('/').map((s) => encodeURIComponent(s)).join('/');
}

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodePath(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function deleteNote(rel: string): Promise<void> {
  await fetch(`${state().apiUrl}/api/notes/${encodePath(rel)}`, { method: 'DELETE' });
}

test.describe('物理ツリー SSE 差分更新', () => {
  test.afterEach(async () => {
    await deleteNote(`${ROOT}/sse-new.md`).catch(() => undefined);
  });

  /**
   * AC-Sd5c9f4-5-4: 外部から PUT で新規ノート作成 → サイドバーツリーに現れる
   * (キャッシュ → SSE → 差分更新のフルパス検証)
   * タイムアウト 2000ms: 1s ガード + awaitWriteFinish 150ms + マージン (AC-Sd5c9f4-5-5)
   */
  test('[AC-5-4] 外部ノート作成後 2s 以内に物理ツリーに現れる', async ({ page }) => {
    await page.goto(state().uiUrl);

    // 物理ビューに切り替え (2 つの同名 testid が存在するため first() で先頭を選択)
    await page.getByTestId('sidebar-view-physical').first().click();
    await expect(page.getByTestId('file-tree')).toBeVisible();

    // sse-new.md はまだない
    await expect(page.locator(`[data-path="${ROOT}/sse-new.md"]`)).toBeHidden();

    // 外部から新規ノートを追加 (PUT API 経由)
    await putNote(`${ROOT}/sse-new.md`, '# SSE New\n\n外部作成ノート\n');

    // 2 秒以内にサイドバーに現れる (chokidar → SSE → App.tsx 差分更新)
    // タイムアウト 2000ms: 1s ガード + awaitWriteFinish 150ms + マージン (AC-Sd5c9f4-5-5)
    await expect(page.locator(`[data-path="${ROOT}/sse-new.md"]`)).toBeVisible({ timeout: 2000 });
  });
});
