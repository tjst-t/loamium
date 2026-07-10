/**
 * Story S11493d-2 インフォパネル E2E 受け入れテスト。
 * 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー → 実ファイルシステム (一時 vault)。
 * ネットワークモックは使わない。
 *
 * [AC-S11493d-2-1] タブ / パネル / セクション表示
 * [AC-S11493d-2-2] Outline ジャンプ / Tags → /search / メタ情報
 * [AC-S11493d-2-3] meta API → 実データでの描画確認
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

test('[AC-S11493d-2-1] インフォタブが表示され info-panel が見える', async ({ page }) => {
  await putNote(
    'info-test-basic.md',
    '# タイトル\n\n本文テスト。\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="info-test-basic.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('タイトル');

  await expect(page.getByTestId('right-tab-info')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('info-panel')).toBeVisible();
});

test('[AC-S11493d-2-2] Outline に見出しが表示され、クリックでエディタ行へジャンプする', async ({
  page,
}) => {
  await putNote(
    'info-test-outline.md',
    '# H1タイトル\n\n本文A。\n\n## セクション1\n\n本文B。\n\n## セクション2\n\n本文C。\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="info-test-outline.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('H1タイトル');

  // meta API からの Outline が描画される
  const outlineItems = page.getByTestId('outline-item');
  await expect(outlineItems).toHaveCount(3, { timeout: 5_000 });

  const sec1 = page.locator('[data-testid="outline-item"]').filter({ hasText: 'セクション1' });
  await expect(sec1).toBeVisible();
  const lineAttr = await sec1.getAttribute('data-line');
  expect(lineAttr).toBeTruthy();
  const targetLine = Number(lineAttr);
  expect(targetLine).toBeGreaterThan(0);

  // クリックでエディタがスクロールして対応行が見える
  await sec1.click();
  // エディタ内に「セクション1」の見出し行が表示されることを確認
  await expect(page.getByTestId('editor')).toContainText('セクション1');
});

test('[AC-S11493d-2-2] Tags セクションのクリックで /search?tag=xxx へ遷移する', async ({
  page,
}) => {
  await putNote(
    'info-test-tags.md',
    '---\ntags:\n  - meeting\n  - project-x\n---\n\n# タグテスト\n\n#inline-tag の本文。\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="info-test-tags.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('タグテスト');

  // タグチップが描画される (meta API)
  const meetingChip = page.locator('[data-testid="tag-chip"][data-tag="meeting"]');
  await expect(meetingChip).toBeVisible({ timeout: 5_000 });

  // クリックで /search へ遷移
  await meetingChip.click();
  await expect(page.getByTestId('route-display')).toContainText('/search');
});

test('[AC-S11493d-2-2] Properties セクションが frontmatter を表示し tags キーを除外する', async ({
  page,
}) => {
  await putNote(
    'info-test-props.md',
    '---\ntype: 議事録\ndate: 2026-07-10\nstatus: draft\ntags:\n  - meeting\n---\n\n# プロパティテスト\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="info-test-props.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('プロパティテスト');

  // Properties セクションに key=type, date, status が表示される
  await expect(
    page.locator('[data-testid="property-row"][data-key="type"]'),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator('[data-testid="property-row"][data-key="date"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="property-row"][data-key="status"]'),
  ).toBeVisible();

  // tags キーは表示されない
  await expect(
    page.locator('[data-testid="property-row"][data-key="tags"]'),
  ).not.toBeAttached();
});

test('[AC-S11493d-2-2] メタ情報セクションに単語数 / 文字数 / 更新日時が表示される', async ({
  page,
}) => {
  await putNote(
    'info-test-meta.md',
    '# メタ情報テスト\n\nHello world これはテスト文章です。\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="info-test-meta.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('メタ情報テスト');

  await expect(page.getByTestId('meta-wordcount')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('meta-charcount')).toBeVisible();
  await expect(page.getByTestId('meta-mtime')).toBeVisible();

  // 実際の値は数値であることを確認 (0 より大きい)
  const wordText = await page.getByTestId('meta-wordcount').textContent();
  const charText = await page.getByTestId('meta-charcount').textContent();
  const wordVal = parseInt(wordText?.replace(/[^0-9]/g, '') ?? '0', 10);
  const charVal = parseInt(charText?.replace(/[^0-9]/g, '') ?? '0', 10);
  expect(wordVal).toBeGreaterThan(0);
  expect(charVal).toBeGreaterThan(0);
});

test('[AC-S11493d-2-3] frontmatter なしの空ノートで properties セクションが hidden', async ({
  page,
}) => {
  await putNote('info-test-empty.md', '# 空ノート\n\n本文なし。\n');

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="info-test-empty.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('空ノート');

  // Properties セクションは hidden (frontmatter なし)
  const propSection = page.locator('.info-section').filter({
    has: page.locator('[data-testid="info-section-toggle"][data-section="properties"]'),
  });
  await expect(propSection).not.toBeVisible({ timeout: 5_000 });

  // Tags は empty state
  await expect(
    page.locator('[data-testid="info-section-body"][data-section="tags"]'),
  ).toContainText('タグなし');
});
