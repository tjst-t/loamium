/**
 * Story S11493d-4 E2E 受け入れテスト: タグクリック → タグ検索ナビゲーション
 *
 * 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー → 実ファイルシステム (一時 vault)。
 * ネットワークモックは使わない。
 *
 * [AC-S11493d-4-1] 共有ハンドラが全タグ表示箇所に適用されている
 * [AC-S11493d-4-2] /search?tag=<tag> への遷移 + URL クエリ同期
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

// ---- [AC-S11493d-4-1/2] InfoPanel Tags セクション ----

test('[AC-S11493d-4-1][AC-S11493d-4-2] InfoPanel Tags チップクリックで /search?tag=<tag> へ遷移', async ({
  page,
}) => {
  await putNote(
    'tag-nav-infopanel.md',
    '---\ntags:\n  - meeting\n  - project-x\n---\n\n# タグナビ\n\n本文。\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="tag-nav-infopanel.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('タグナビ');

  // InfoPanel Tags セクションに tag-chip が表示されるまで待つ
  const tagChip = page.locator('[data-testid="tag-chip"][data-tag="meeting"]');
  await expect(tagChip).toBeVisible({ timeout: 5_000 });

  // クリックで /search?tag=meeting へ遷移
  await tagChip.click();
  await expect(page.getByTestId('route-display')).toContainText('/search');
  await expect(page).toHaveURL(/[?&]tag=meeting/);
});

// ---- [AC-S11493d-4-1/2] properties.ts タグチップ ----

test('[AC-S11493d-4-1][AC-S11493d-4-2] properties.ts frontmatter タグチップクリックで /search?tag=<tag> へ遷移', async ({
  page,
}) => {
  await putNote(
    'tag-nav-props.md',
    '---\ntags: [frontend, ui]\nstatus: active\n---\n\n# プロパティタグナビ\n\n本文。\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="tag-nav-props.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('プロパティタグナビ');

  // properties-widget が表示されるまで待つ
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible({ timeout: 5_000 });

  // 畳まれている場合は展開
  const isOpen = await widget.getAttribute('data-open');
  if (isOpen !== 'true') {
    await widget.getByTestId('properties-toggle').click();
    await expect(widget).toHaveAttribute('data-open', 'true');
  }

  // tags チップが表示される
  const tagChip = widget.locator('[data-testid="properties-chip"][data-value="frontend"]');
  await expect(tagChip).toBeVisible();

  // クリックで /search?tag=frontend へ遷移
  await tagChip.click();
  await expect(page.getByTestId('route-display')).toContainText('/search');
  await expect(page).toHaveURL(/[?&]tag=frontend/);
});

// ---- [AC-S11493d-4-1/2] dataview TABLE の dv-tag チップ ----

test('[AC-S11493d-4-1][AC-S11493d-4-2] dataview TABLE の dv-tag チップクリックで /search?tag=<tag> へ遷移', async ({
  page,
}) => {
  // dataview クエリ用のノートを作成
  await putNote(
    'tag-nav-data.md',
    '---\ntags: [project, milestone]\n---\n\n# データ\n\n本文。\n',
  );

  // dataview を使うノートを作成
  await putNote(
    'tag-nav-dv.md',
    ['```dataview', 'TABLE tags from ""', '```', '', '本文テスト。', ''].join('\n'),
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="tag-nav-dv.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('本文テスト');

  // フェンス外の行をクリックしてフェンスをウィジェット化
  const anchor = page.locator('[data-testid="editor"] .cm-line', { hasText: '本文テスト' }).first();
  await anchor.click();

  // dataview-widget が描画される
  const widget = page.getByTestId('dataview-widget');
  await expect(widget).toHaveAttribute('data-query-type', 'table', { timeout: 5_000 });

  // dv-tag チップが表示される
  const tagChip = widget.locator('[data-testid="dataview-tag"]').first();
  await expect(tagChip).toBeVisible();
  const tagVal = await tagChip.getAttribute('data-tag');
  expect(tagVal).toBeTruthy();

  // クリックで /search?tag=<tag> へ遷移
  await tagChip.click({ force: true });
  await expect(page.getByTestId('route-display')).toContainText('/search');
  await expect(page).toHaveURL(new RegExp(`[?&]tag=${encodeURIComponent(tagVal ?? '')}`));
});
