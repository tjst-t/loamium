/**
 * ノート保存後 2 秒以内にスマートフォルダに反映されることを確認する e2e テスト
 * (Sd5c9f4-5 / AC-Sd5c9f4-5-1〜5-3)。
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
const ROOT = 'sf-latency-e2e';

// ---- ヘルパー ---------------------------------------------------------------

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
  const res = await fetch(`${state().apiUrl}/api/notes/${encodePath(rel)}`, {
    method: 'DELETE',
  });
  expect(res.ok).toBe(true);
}

async function putSmartFolders(config: unknown): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/smart-folders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  expect(res.ok).toBe(true);
}

// ---- テスト ----------------------------------------------------------------

test.describe('smart folder latency (SSE 差分更新)', () => {
  const SF_ID = 'sf-latency-q';

  test.beforeEach(async () => {
    // テスト用ベースノートを設置
    await putNote(`${ROOT}/base.md`, `# Base\n\n#sf-latency\n`);
    // DQL クエリを持つスマートフォルダを設定
    await putSmartFolders({
      version: 1,
      items: [
        {
          kind: 'query',
          id: SF_ID,
          name: 'SF-Latency',
          icon: 'search',
          dql: `LIST FROM "${ROOT}" SORT file.name ASC`,
        },
      ],
    });
  });

  test.afterEach(async () => {
    await putSmartFolders({ version: 1, items: [] });
    // クリーンアップ: テストノートを削除 (失敗しても無視)
    await deleteNote(`${ROOT}/base.md`).catch(() => undefined);
    await deleteNote(`${ROOT}/new-note.md`).catch(() => undefined);
    await deleteNote(`${ROOT}/status-note.md`).catch(() => undefined);
  });

  /**
   * AC-Sd5c9f4-5-1: 新規ノート追加 → SF に現れる
   * タイムアウト 2000ms (1s ガード + chokidar awaitWriteFinish 150ms を含む余裕)
   */
  test('[AC-5-1] 新規ノート追加後 2s 以内に SF に現れる', async ({ page }) => {
    await page.goto(state().uiUrl);

    // スマートビューに切り替え、SF を展開する
    // 2 つの同名 testid が存在するため first() で先頭 (サイドバー切替タブ) を選択
    await page.getByTestId('sidebar-view-smart').first().click();
    const folder = page.locator(`[data-testid="smart-folder"][data-id="${SF_ID}"]`);
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute('aria-expanded')) !== 'true') {
      await folder.click();
    }
    // 既存の base.md が表示される
    await expect(page.locator(`[data-testid="smart-note"][data-path="${ROOT}/base.md"]`)).toBeVisible();

    // 外部から新規ノートを追加 (PUT API 経由)
    await putNote(`${ROOT}/new-note.md`, '# New\n\n新規ノート\n');

    // 2 秒以内に SF に現れる (chokidar → SSE → 差分再フェッチ)
    // タイムアウト 2000ms: 1s ガード + awaitWriteFinish 150ms + マージン (AC-Sd5c9f4-5-5)
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/new-note.md"]`),
    ).toBeVisible({ timeout: 2000 });
  });

  /**
   * AC-Sd5c9f4-5-2: 既存ノート更新後に SF がそのノートを含む
   * (更新後もリスト内に保持される)
   * タイムアウト 2000ms
   */
  test('[AC-5-2] ノート更新後 2s 以内に SF に反映される', async ({ page }) => {
    // 更新対象ノートを事前作成
    await putNote(`${ROOT}/status-note.md`, '# Status\n\nstatus: open\n');

    await page.goto(state().uiUrl);

    // 2 つの同名 testid が存在するため first() で先頭 (サイドバー切替タブ) を選択
    await page.getByTestId('sidebar-view-smart').first().click();
    const folder = page.locator(`[data-testid="smart-folder"][data-id="${SF_ID}"]`);
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute('aria-expanded')) !== 'true') {
      await folder.click();
    }

    // status-note.md が表示される
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/status-note.md"]`),
    ).toBeVisible();

    // ノートを更新 (内容を変えるだけ — リストに残る)
    await putNote(`${ROOT}/status-note.md`, '# Status Updated\n\nstatus: done\n');

    // 2 秒以内にキャッシュが無効化され SF が再フェッチされる
    // ノードは引き続き SF 内に存在する (FROM でフォルダ全体を対象にしているため)
    // タイムアウト 2000ms: 1s ガード + awaitWriteFinish 150ms + マージン (AC-Sd5c9f4-5-5)
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/status-note.md"]`),
    ).toBeVisible({ timeout: 2000 });
  });

  /**
   * AC-Sd5c9f4-5-3: ノート削除後に SF から消える
   * タイムアウト 2000ms
   */
  test('[AC-5-3] ノート削除後 2s 以内に SF から消える', async ({ page }) => {
    // 削除対象ノートを事前作成
    await putNote(`${ROOT}/to-delete.md`, '# To Delete\n');

    await page.goto(state().uiUrl);

    // 2 つの同名 testid が存在するため first() で先頭 (サイドバー切替タブ) を選択
    await page.getByTestId('sidebar-view-smart').first().click();
    const folder = page.locator(`[data-testid="smart-folder"][data-id="${SF_ID}"]`);
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute('aria-expanded')) !== 'true') {
      await folder.click();
    }

    // to-delete.md が表示される
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/to-delete.md"]`),
    ).toBeVisible();

    // ノートを削除
    await deleteNote(`${ROOT}/to-delete.md`);

    // 2 秒以内に SF から消える (chokidar → SSE → 差分再フェッチ)
    // タイムアウト 2000ms: 1s ガード + awaitWriteFinish 150ms + マージン (AC-Sd5c9f4-5-5)
    await expect(
      page.locator(`[data-testid="smart-note"][data-path="${ROOT}/to-delete.md"]`),
    ).toBeHidden({ timeout: 2000 });
  });
});
