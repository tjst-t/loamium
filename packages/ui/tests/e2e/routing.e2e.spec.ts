/**
 * Story Sf1a90a-1 E2E — History API ベースのルーティングと戻る/進む。
 *
 * 実ブラウザ → 実 Vite → 実サーバー (test-discipline Rule 2/4)。
 * 検証ノートはテスト内で API 作成し、直近一覧の先頭に来る前提で操作する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const A = 'route-a-e2e.md';
const B = 'route-b-e2e.md';

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`putNote ${rel} failed: ${String(res.status)}`);
}

/** A は B への [[リンク]] と ![[embed]] を含む。B は A からの参照を受ける。 */
async function seed(): Promise<void> {
  await putNote(B, '# Route B\n\n本文B です。\n');
  await putNote(A, '# Route A\n\n本文A です。\n\n参照 [[route-b-e2e]]\n\n![[route-b-e2e]]\n');
}

async function openViaTree(page: Page, rel: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
}

test('[AC-Sf1a90a-1-1] ノート遷移が履歴に積まれ、ブラウザおよび UI の戻る/進むで移動できる', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);

  await openViaTree(page, A);
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);

  await openViaTree(page, B);
  await expect(page.getByTestId('editor')).toContainText('本文B');
  await expect(page).toHaveURL(/\/n\/route-b-e2e$/);

  // ブラウザの戻る → A / 進む → B
  await page.goBack();
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);
  await page.goForward();
  await expect(page.getByTestId('editor')).toContainText('本文B');

  // UI ヘッダの戻る/進むボタンでも移動できる
  await page.getByTestId('nav-back').click();
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await page.getByTestId('nav-forward').click();
  await expect(page.getByTestId('editor')).toContainText('本文B');

  // アセット一覧 (/files) への遷移も履歴に積まれる
  await page.getByTestId('sidebar-show-all').click();
  await expect(page.getByTestId('files-list')).toBeVisible();
  await expect(page).toHaveURL(/\/files$/);
  await page.getByTestId('nav-back').click();
  await expect(page.getByTestId('editor')).toContainText('本文B');
});

test('[AC-Sf1a90a-1-2] メインは 1 画面 (タブなし)。開いているノートが URL に反映されリロードで復帰する', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);

  // タブ UI は存在しない (ワークスペースは常に 1 画面)
  await expect(page.getByTestId('workspace-tabs')).toHaveCount(0);
  await expect(page.getByTestId('tab-terminal')).toHaveCount(0);
  await expect(page.getByTestId('tab-editor')).toHaveCount(0);

  await openViaTree(page, A);
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);
  // route-display は現在ルート (URL セグメント) を表示する
  await expect(page.getByTestId('route-display')).toContainText('route-a-e2e');

  // リロードしても同じノートに戻る (URL 復帰)
  await page.reload();
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);
});

test('[AC-Sf1a90a-1-3] [[リンク]] からの遷移が履歴に積まれ、戻るで直前のノートに戻れる', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);
  await openViaTree(page, A);
  await expect(page.getByTestId('editor')).toContainText('本文A');

  const link = page.locator('[data-testid="wikilink"][data-target="route-b-e2e.md"]');
  await expect(link.first()).toBeVisible();
  await link.first().click();
  await expect(page.getByTestId('editor')).toContainText('本文B');
  await expect(page).toHaveURL(/\/n\/route-b-e2e$/);

  await page.goBack();
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);
});

test('[AC-Sf1a90a-1-3] embed からの遷移が履歴に積まれ、戻るで直前のノートに戻れる', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);
  await openViaTree(page, A);
  await expect(page.getByTestId('editor')).toContainText('本文A');

  const embedOpen = page.getByTestId('embed-card-open').first();
  await expect(embedOpen).toBeVisible();
  await embedOpen.click();
  await expect(page.getByTestId('editor')).toContainText('本文B');
  await expect(page).toHaveURL(/\/n\/route-b-e2e$/);

  await page.goBack();
  await expect(page.getByTestId('editor')).toContainText('本文A');
});

test('[AC-Sf1a90a-1-3] バックリンクからの遷移が履歴に積まれ、戻るで直前のノートに戻れる', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);
  // B を開く → 右サイドバーのバックリンクに A が出る (A → B のリンク)
  await openViaTree(page, B);
  await expect(page.getByTestId('editor')).toContainText('本文B');

  // A は [[リンク]] と ![[embed]] の 2 箇所で B を参照するため backlink-item は 2 件
  const backlink = page.locator('[data-testid="backlink-item"][data-source="route-a-e2e.md"]').first();
  await expect(backlink).toBeVisible();
  await backlink.click();
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);

  await page.goBack();
  await expect(page.getByTestId('editor')).toContainText('本文B');
  await expect(page).toHaveURL(/\/n\/route-b-e2e$/);
});

test('[AC-Sf1a90a-1-3] 検索結果からの遷移が履歴に積まれ、戻るで直前のノートに戻れる', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);
  await openViaTree(page, A);
  await expect(page.getByTestId('editor')).toContainText('本文A');

  // Cmd/Ctrl+K で検索パレットを開き、B を選んで開く
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.getByTestId('search-input').fill('route-b-e2e');
  const result = page.locator('[data-testid="search-result-note"][data-path="route-b-e2e.md"]');
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId('editor')).toContainText('本文B');
  await expect(page).toHaveURL(/\/n\/route-b-e2e$/);

  await page.goBack();
  await expect(page.getByTestId('editor')).toContainText('本文A');
  await expect(page).toHaveURL(/\/n\/route-a-e2e$/);
});
