/**
 * Story S8086d9-2 E2E — ノートヘッダ右上のブックマークスター。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実ファイルシステム。
 * 依存: Sprint S32940c(POST /api/notes/{path}/properties, DQL WHERE bookmark, smart-folders 解決)。
 * 一意プレフィックス (bm-e2e)。smart-folders.json は beforeEach で設定し afterEach で空に戻す。
 */
import { test, expect, type Locator } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();
const ROOT = 'bm-e2e';

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

async function putSmartFolders(config: unknown): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/smart-folders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  expect(res.ok).toBe(true);
}

async function expandFolder(folder: Locator): Promise<void> {
  if ((await folder.getAttribute('aria-expanded')) !== 'true') {
    await folder.click();
  }
}

test.describe('bookmark star', () => {
  test.beforeEach(async () => {
    // frontmatter 無しで作成 (前テストの bookmark を確実にリセット)
    await putNote(`${ROOT}/target.md`, '# Target\n\n本文ターゲット\n');
    await putSmartFolders({
      version: 1,
      items: [{ kind: 'query', id: 'bm-marks', name: 'ブックマーク', icon: 'star', dql: 'LIST WHERE bookmark' }],
    });
  });

  test.afterEach(async () => {
    await putSmartFolders({ version: 1, items: [] });
  });

  test('[AC-S8086d9-2-1] スターは常時表示され、bookmark 無しでは枠のみ', async ({ page }) => {
    await page.goto(`${state().uiUrl}/n/${ROOT}/target`);
    await expect(page.getByTestId('editor')).toContainText('本文ターゲット');
    const star = page.getByTestId('bookmark-star');
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('data-bookmarked', 'false');
  });

  test('[AC-S8086d9-2-2] クリックで bookmark を付与/解除し即時反映、リロードで永続', async ({ page }) => {
    await page.goto(`${state().uiUrl}/n/${ROOT}/target`);
    await expect(page.getByTestId('editor')).toContainText('本文ターゲット');

    await page.getByTestId('bookmark-star').click();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
    // frontmatter に永続 → リロードで復元
    await page.reload();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');

    // 再クリックで解除 → 永続
    await page.getByTestId('bookmark-star').click();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
    await page.reload();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
  });

  test('[AC-S8086d9-2-4] ブックマーク付与後エディタ内容に bookmark: true が反映され、解除後に消える', async ({ page }) => {
    await page.goto(`${state().uiUrl}/n/${ROOT}/target`);
    await expect(page.getByTestId('editor')).toContainText('本文ターゲット');

    // ブックマーク付与 → エディタの内容に frontmatter が現れる
    await page.getByTestId('bookmark-star').click();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');
    await expect(page.getByTestId('editor')).toContainText('bookmark: true');

    // 解除 → エディタから bookmark: true が消える
    await page.getByTestId('bookmark-star').click();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
    await expect(page.getByTestId('editor')).not.toContainText('bookmark: true');
  });

  test('[AC-S8086d9-2-3] ブックマークすると LIST WHERE bookmark のスマートフォルダに現れ、解除で消える', async ({ page }) => {
    await page.goto(`${state().uiUrl}/n/${ROOT}/target`);
    await expect(page.getByTestId('editor')).toContainText('本文ターゲット');

    await page.getByTestId('bookmark-star').click();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'true');

    // スマートビューのブックマークフォルダに出現
    await page.getByTestId('sidebar-view-smart').click();
    const folder = page.locator('[data-testid="smart-folder"][data-id="bm-marks"]');
    await expandFolder(folder);
    await expect(page.locator(`[data-testid="smart-note"][data-path="${ROOT}/target.md"]`)).toBeVisible();

    // 解除すると消える
    await page.getByTestId('sidebar-view-physical').click();
    await page.getByTestId('bookmark-star').click();
    await expect(page.getByTestId('bookmark-star')).toHaveAttribute('data-bookmarked', 'false');
    await page.getByTestId('sidebar-view-smart').click();
    const folder2 = page.locator('[data-testid="smart-folder"][data-id="bm-marks"]');
    await expandFolder(folder2);
    await expect(page.locator(`[data-testid="smart-note"][data-path="${ROOT}/target.md"]`)).toHaveCount(0);
  });
});
