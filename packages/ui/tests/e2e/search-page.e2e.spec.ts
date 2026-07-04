/**
 * Story S935867-1 E2E — 詳細検索ページ (実ブラウザ → 実 Vite → 実サーバー)。
 *
 * 受け入れ条件を実操作で検証する (test-discipline Rule 2/4):
 *  - AC-1-1: 条件を指定して検索し、結果一覧を開いたまま複数の結果を順に閲覧できる
 *  - AC-1-2: 条件が URL に反映され、戻る/進む・ブックマーク(リロード)で再現できる
 *  - AC-1-3: 最近の検索履歴が表示され、クリックで同じ検索を再実行できる
 * さらに Cmd+K ポップアップとの 2 モード共存 (パレットの「詳細検索を開く」導線) を検証する。
 *
 * 共有 vault の他ノートと衝突しないよう、ユニークなキーワード・パス・タグを使う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const KW = 'zqバクアプ検索語';
const TAG = 'sp935infra';
const N1 = 'sp935/hydra-e2e.md';
const N2 = 'sp935/server-e2e.md';
const N3 = 'sp935/book-e2e.md';

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`putNote ${rel} failed: ${String(res.status)}`);
}

async function seed(): Promise<void> {
  await putNote(N1, `---\ntags: [${TAG}]\n---\n# Hydra 設計メモ e2e\n\n${KW} の 3-2-1 バックアップ方針。\n`);
  await putNote(N2, `---\ntags: [${TAG}]\n---\n# 自宅サーバー構成 e2e\n\n週次の ${KW} を B2 へ。\n`);
  // 別タグ・別フォルダ相当: タグ絞り込みで除外されることの確認用
  await putNote(N3, `---\ntags: [sp935reading]\n---\n# 失敗の科学 e2e\n\n読書メモに ${KW} が出てくる。\n`);
}

async function submitSearch(page: Page): Promise<void> {
  await page.getByTestId('search-submit').click();
}

test('[AC-S935867-1-1] 条件検索し、結果一覧を開いたまま複数の結果を順に閲覧できる (ポップアップと 2 モード共存)', async ({
  page,
}) => {
  await seed();
  await page.goto(state().uiUrl);

  // --- 2 モード共存: Cmd+K パレットから「詳細検索を開く」で /search へ ---
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.getByTestId('search-input').fill(KW);
  await page.getByTestId('search-open-advanced').click();
  await expect(page.getByTestId('search-palette')).toHaveCount(0);
  await expect(page.getByTestId('search-page')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(KW)}`));
  await expect(page.getByTestId('search-field-fulltext')).toHaveValue(KW);

  // 全文だけでは 3 件 (N1/N2/N3) ヒットする
  await expect(page.getByTestId('search-result-item')).toHaveCount(3);

  // タグで絞り込む → N3 (別タグ) が除外され 2 件に
  await page.getByTestId('search-field-tag').fill(TAG);
  await submitSearch(page);
  await expect(page).toHaveURL(new RegExp(`tag=${TAG}`));
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
  await expect(page.locator(`[data-testid="search-result-item"][data-path="${N3}"]`)).toHaveCount(0);

  // --- 結果を開いても一覧は保持され、複数の結果を順に閲覧できる ---
  await page.locator(`[data-testid="search-result-item"][data-path="${N1}"]`).click();
  await expect(page.getByTestId('search-preview-pane')).toBeVisible();
  await expect(page.getByTestId('search-preview-pane')).toContainText('Hydra 設計メモ e2e');
  // 一覧は閉じない (ポップアップと違う)
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  await page.locator(`[data-testid="search-result-item"][data-path="${N2}"]`).click();
  await expect(page.getByTestId('search-preview-pane')).toContainText('自宅サーバー構成 e2e');
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
  await expect(page.locator(`[data-testid="search-result-item"][data-path="${N2}"].active`)).toBeVisible();

  // プレビューから実エディタへも遷移できる (探索 → 編集)
  await page.getByTestId('search-preview-open-editor').click();
  await expect(page.getByTestId('editor')).toContainText('自宅サーバー構成 e2e');
  await expect(page).toHaveURL(/\/n\/sp935\/server-e2e$/);
});

test('[AC-S935867-1-2] 検索条件が URL に反映され、戻る/進む・ブックマーク(リロード)で再現できる', async ({
  page,
}) => {
  await seed();
  await page.goto(`${state().uiUrl}/search`);
  await expect(page.getByTestId('search-page')).toBeVisible();

  // 条件1: 全文のみ
  await page.getByTestId('search-field-fulltext').fill(KW);
  await submitSearch(page);
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(KW)}$`));
  await expect(page.getByTestId('search-result-item')).toHaveCount(3);

  // 条件2: 全文 + タグ (URL に tag が加わる)
  await page.getByTestId('search-field-tag').fill(TAG);
  await submitSearch(page);
  await expect(page).toHaveURL(new RegExp(`tag=${TAG}`));
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  // 戻る → 条件1 (全文のみ) が復元。フォームと結果の両方が戻る
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(KW)}$`));
  await expect(page.getByTestId('search-field-tag')).toHaveValue('');
  await expect(page.getByTestId('search-result-item')).toHaveCount(3);

  // 進む → 条件2 が復元
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`tag=${TAG}`));
  await expect(page.getByTestId('search-field-tag')).toHaveValue(TAG);
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  // ブックマーク再現: 条件2 の URL を直接開き直しても同じ検索になる
  const bookmarked = page.url();
  await page.goto(bookmarked);
  await expect(page.getByTestId('search-page')).toBeVisible();
  await expect(page.getByTestId('search-field-fulltext')).toHaveValue(KW);
  await expect(page.getByTestId('search-field-tag')).toHaveValue(TAG);
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
});

test('[AC-S935867-1-3] 最近の検索履歴が表示され、クリックで同じ検索を再実行できる', async ({ page }) => {
  await seed();
  await page.goto(`${state().uiUrl}/search`);
  await expect(page.getByTestId('search-page')).toBeVisible();

  // 検索1: 全文 KW
  await page.getByTestId('search-field-fulltext').fill(KW);
  await submitSearch(page);
  await expect(page.getByTestId('search-result-item')).toHaveCount(3);

  // 検索2: タグ TAG (全文クリア)
  await page.getByTestId('search-field-fulltext').fill('');
  await page.getByTestId('search-field-tag').fill(TAG);
  await submitSearch(page);
  await expect(page).toHaveURL(new RegExp(`/search\\?tag=${TAG}$`));
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);

  // 結果を開いていない状態では右カラムに履歴が出る (localStorage)
  await expect(page.getByTestId('search-history')).toBeVisible();
  const kwHistory = page.locator(
    `[data-testid="search-history-item"][data-query="q=${encodeURIComponent(KW)}"]`,
  );
  await expect(kwHistory).toBeVisible();

  // 履歴クリックで検索1 (全文 KW) が再実行され、URL と結果が復元される
  await kwHistory.click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(KW)}$`));
  await expect(page.getByTestId('search-field-fulltext')).toHaveValue(KW);
  await expect(page.getByTestId('search-field-tag')).toHaveValue('');
  await expect(page.getByTestId('search-result-item')).toHaveCount(3);
});
