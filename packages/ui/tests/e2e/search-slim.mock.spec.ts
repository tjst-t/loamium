/**
 * Story Sa629e2-3 mock テスト (検索ページのスリム化)。
 * page.route で全 /api/* をモックし、インラインバー・密な結果行・右サイドバー
 * 非表示 (マウント維持) の UI 挙動を固める。実サーバーでの本検証は
 * search-slim.e2e.spec.ts が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const NOTES = {
  notes: [
    { path: 'infra/backup.md', title: 'バックアップ方針', tags: ['infra'], folder: 'infra', mtime: 1751500000000 },
    { path: 'infra/server.md', title: 'サーバー構成', tags: ['infra'], folder: 'infra', mtime: 1751400000000 },
  ],
};

const SEARCH = {
  query: 'バックアップ',
  results: [
    {
      path: 'infra/backup.md',
      title: 'バックアップ方針',
      snippet: '週次のバックアップを B2 へ。3-2-1 ルールで冗長化する。',
      score: 0.1,
      line: 3,
    },
    {
      path: 'infra/server.md',
      title: 'サーバー構成',
      snippet: 'バックアップ先のディスク構成。',
      score: 0.2,
      line: 5,
    },
  ],
};

async function installSearchMocks(page: Page): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => void route.fulfill(json(NOTES)));
  await page.route('**/api/search**', (route) => void route.fulfill(json(SEARCH)));
  return unexpected;
}

test('[MOCK] 条件が 1 行のインラインバーにまとまり、Cmd+K の説明メッセージは表示されない', async ({
  page,
}) => {
  const unexpected = await installSearchMocks(page);
  await page.goto(`${readHarnessState().uiUrl}/search`);
  await expect(page.getByTestId('search-form')).toBeVisible();

  // 説明メッセージが無い (AC-Sa629e2-3-1)
  await expect(page.getByTestId('search-page')).not.toContainText('Cmd+K');
  await expect(page.getByTestId('search-page')).not.toContainText('ジャンプ用');

  // 5 コントロールが同一の行 (Y 帯が重なる) に並ぶ
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
    // 中心 Y が先頭コントロールの範囲内 = 同じ行
    const cy = b.y + b.height / 2;
    expect(cy).toBeGreaterThanOrEqual(first.y - 2);
    expect(cy).toBeLessThanOrEqual(first.y + first.height + 2);
  }
  // バー全体がコンパクト (縦積みフォームではない)
  const form = await page.getByTestId('search-form').boundingBox();
  if (form === null) throw new Error('form の bounding box が取得できませんでした');
  expect(form.height).toBeLessThan(60);
  expect(unexpected).toEqual([]);
});

test('[MOCK] キーワード入力欄で Enter を押すと検索が実行される (URL 同期 + 結果表示)', async ({
  page,
}) => {
  const unexpected = await installSearchMocks(page);
  await page.goto(`${readHarnessState().uiUrl}/search`);
  await page.getByTestId('search-field-fulltext').fill('バックアップ');
  await page.getByTestId('search-field-fulltext').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByTestId('search-result-item')).toHaveCount(2);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 結果行が密 (タイトル・パス・スニペット・更新日時が 1〜2 行に収まる)', async ({ page }) => {
  const unexpected = await installSearchMocks(page);
  await page.goto(`${readHarnessState().uiUrl}/search?q=%E3%83%90%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%97`);
  const row = page.locator('[data-testid="search-result-item"][data-path="infra/backup.md"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('バックアップ方針');
  await expect(row).toContainText('infra/backup.md');
  await expect(row).toContainText('週次のバックアップ');
  await expect(row).toContainText('更新');
  const box = await row.boundingBox();
  if (box === null) throw new Error('row の bounding box が取得できませんでした');
  expect(box.height).toBeLessThan(60);
  expect(unexpected).toEqual([]);
});

test('[MOCK] /search では右サイドバーが非表示になり、DOM からは外れない (マウント維持)', async ({
  page,
}) => {
  const DATE = '2026-07-03';
  const JOURNAL_PATH = `journals/${DATE}.md`;
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) =>
    void route.fulfill(json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] })),
  );
  // ?date=… 付きの再取得 (戻る遷移) も同じモックで受ける
  await page.route('**/api/journal**', (route) =>
    void route.fulfill(
      json({ date: DATE, path: JOURNAL_PATH, content: 'ノート本文。', frontmatter: null, body: 'ノート本文。', created: false, mtime: 1000 }),
    ),
  );
  await page.route('**/api/backlinks**', (route) => void route.fulfill(json({ path: JOURNAL_PATH, backlinks: [] })));
  await page.route('**/api/search**', (route) => void route.fulfill(json({ query: 'x', results: [] })));

  // ノートルート: 右サイドバー表示
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('ノート本文');
  await expect(page.getByTestId('right-sidebar')).toBeVisible();

  // アプリ内遷移で /search へ (Cmd+K → 詳細検索) → 右サイドバーは非表示だが DOM には残る
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').fill('x');
  await page.getByTestId('search-open-advanced').click();
  await expect(page.getByTestId('search-page')).toBeVisible();
  await expect(page.getByTestId('right-sidebar')).toBeHidden();
  await expect(page.getByTestId('right-sidebar')).toBeAttached();

  // 戻る → ノートルートで再表示
  await page.goBack();
  await expect(page.getByTestId('editor')).toContainText('ノート本文');
  await expect(page.getByTestId('right-sidebar')).toBeVisible();
  expect(unexpected).toEqual([]);
});
