/**
 * Story Sf1a90a-3 E2E — サイドバーの直近ファイル (mtime 順の直近 N=10 件)。
 *
 * 実ブラウザ → 実 Vite → 実サーバー。13 ノートを mtime 昇順で作成し、
 * サイドバーが直近 10 件に絞られること、古い 3 件は出ないこと、「すべて表示」で
 * ファイル一覧ページ (/files) へ遷移することを検証する。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const COUNT = 13;
const rel = (i: number): string => `recent-${String(i).padStart(2, '0')}-e2e.md`;

async function putNote(path: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`putNote ${path} failed: ${String(res.status)}`);
}

test('[AC-Sf1a90a-3-1] サイドバーは直近 10 件に絞られ、「すべて表示」で /files へ遷移する', async ({
  page,
}) => {
  // recent-01 (最古) … recent-13 (最新) を mtime 昇順で作成する
  for (let i = 1; i <= COUNT; i++) {
    await putNote(rel(i), `# Recent ${String(i)}\n\n本文 ${String(i)}\n`);
    await new Promise((r) => setTimeout(r, 6)); // mtime を確実に区別する
  }

  await page.goto(state().uiUrl);

  // 最新ノートを開く → 直近一覧の最上位 (active)。以後サイドバーは直近 10 件ちょうど。
  const newest = page.locator(`[data-testid="tree-item"][data-path="${rel(COUNT)}"]`);
  await expect(newest).toBeVisible();
  await newest.click();
  await expect(newest).toHaveClass(/active/);

  // 直近一覧は 10 件に絞られている (tree-item + tree-file 合わせて 10)
  const listItems = page.locator('[data-testid="file-tree"] button[data-path]');
  await expect(listItems).toHaveCount(10);

  // 最新 (recent-13) は出るが、最古 (recent-01/02/03) は直近から外れる
  await expect(page.locator(`[data-testid="tree-item"][data-path="${rel(COUNT)}"]`)).toBeVisible();
  for (const i of [1, 2, 3]) {
    await expect(page.locator(`[data-testid="tree-item"][data-path="${rel(i)}"]`)).toHaveCount(0);
  }

  // 「すべて表示」でファイル一覧ページ (/files) へ遷移する
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId('files-page-placeholder')).toBeVisible();
});
