/**
 * Story Sa629e2-3「検索ページのスリム化」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー。
 * ネットワークモックは使わない。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const KW = 'zqスリム検索語a629';
const N1 = 'slim/バックアップ方針-e2e.md';
const N2 = 'slim/サーバー構成-e2e.md';

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

async function seed(): Promise<void> {
  await putNote(N1, `# バックアップ方針 e2e\n\n${KW} の 3-2-1 バックアップ方針を決める。\n`);
  await putNote(N2, `# サーバー構成 e2e\n\n週次の ${KW} を B2 へ送る。\n`);
}

test('[AC-Sa629e2-3-1] 条件がコンパクトな 1 行インラインバーにまとまり、Cmd+K の説明は出ない。Enter で検索できる', async ({
  page,
}) => {
  await seed();
  await page.goto(`${state().uiUrl}/search`);
  await expect(page.getByTestId('search-form')).toBeVisible();

  // 「Cmd+K は 1 件開くと閉じる…」の説明メッセージは表示されない
  await expect(page.getByTestId('search-page')).not.toContainText('Cmd+K');
  await expect(page.getByTestId('search-page')).not.toContainText('ジャンプ用');

  // キーワード・タグ・フォルダ・並び順・検索が同一の行に並ぶ (インライン配置)
  const ids = [
    'search-field-fulltext',
    'search-field-tag',
    'search-field-folder',
    'search-field-sort',
    'search-submit',
  ];
  const boxes = [];
  for (const id of ids) {
    const b = await page.getByTestId(id).boundingBox();
    if (b === null) throw new Error(`${id} の bounding box が取得できませんでした`);
    boxes.push(b);
  }
  const first = boxes[0];
  if (first === undefined) throw new Error('boxes empty');
  for (const b of boxes) {
    const cy = b.y + b.height / 2;
    expect(cy).toBeGreaterThanOrEqual(first.y - 2);
    expect(cy).toBeLessThanOrEqual(first.y + first.height + 2);
  }
  const form = await page.getByTestId('search-form').boundingBox();
  if (form === null) throw new Error('form の bounding box が取得できませんでした');
  expect(form.height).toBeLessThan(60);

  // Enter で検索が実行され、URL に同期し、実サーバーの結果が出る
  await page.getByTestId('search-field-fulltext').fill(KW);
  await page.getByTestId('search-field-fulltext').press('Enter');
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(KW)}`));
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
});

test('[AC-Sa629e2-3-2] 結果行が密なリスト (タイトル・パス・スニペット・更新日時を 1〜2 行に詰めた配置)', async ({
  page,
}) => {
  await seed();
  await page.goto(`${state().uiUrl}/search?q=${encodeURIComponent(KW)}`);
  const row = page.locator(`[data-testid="search-result-item"][data-path="${N1}"]`);
  await expect(row).toBeVisible();

  // タイトル・パス・スニペット・更新日時が 1 行 + スニペット 1 行に収まる
  await expect(row).toContainText('バックアップ方針-e2e');
  await expect(row).toContainText(N1);
  await expect(row).toContainText(KW); // スニペット (キーワード周辺)
  await expect(row).toContainText('更新');
  const box = await row.boundingBox();
  if (box === null) throw new Error('row の bounding box が取得できませんでした');
  expect(box.height).toBeLessThan(60);

  // 密でも従来機能は維持: クリックでプレビューが開き一覧は残る
  await row.click();
  await expect(page.getByTestId('search-preview-pane')).toBeVisible();
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
});

test('[AC-Sa629e2-3-3] /search では右サイドバーが非表示になり、ノートに戻ると復帰する', async ({
  page,
}) => {
  await seed();

  // ノートルート: 右サイドバーが見える
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('right-sidebar')).toBeVisible();

  // アプリ内遷移で /search へ (Cmd+K パレット → 詳細検索を開く)
  await page.getByTestId('route-display').click();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.getByTestId('search-input').fill(KW);
  await page.getByTestId('search-open-advanced').click();
  await expect(page.getByTestId('search-page')).toBeVisible();

  // 右サイドバーは表示されない — ただし DOM には残る
  await expect(page.getByTestId('right-sidebar')).toBeHidden();
  await expect(page.getByTestId('right-sidebar')).toBeAttached();

  // ノートルートへ戻る (結果クリック → エディタで開く) → 右サイドバー復帰
  await page.locator(`[data-testid="search-result-item"][data-path="${N1}"]`).click();
  await page.getByTestId('search-preview-open-editor').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('right-sidebar')).toBeVisible();
});
