/**
 * Story S87f4b7-1「プロパティブロックの再設計(折りたたみ + ミニマル2カラム)」
 * E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * ビジュアルの正は prototype/props-redesign/chosen.html。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openNoteFromTree(page: Page, rel: string, waitText: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

test('[AC-S87f4b7-1-1] frontmatter があると既定で畳まれ、本文直前に `>` トグルのみ(要約なし)', async ({
  page,
}) => {
  await putNote(
    'layout/collapsed.md',
    [
      '---',
      'tags: [sample-book]',
      'status: 読了',
      'rating: 4',
      'created: 2026-05-20',
      '---',
      '',
      '# 失敗から学ぶ',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'layout/collapsed.md', 'アンカー行');

  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  // 既定は畳み
  await expect(widget).toHaveAttribute('data-open', 'false');
  // 本文直前は `>` トグルだけ。要約テキスト (プロパティ #sample-book …) は「見えない」
  // (密行は DOM に残るが display:none。表示上のサマリは出さない)
  await expect(widget.getByTestId('properties-toggle')).toBeVisible();
  await expect(widget.getByTestId('properties-row').first()).toBeHidden();
  await expect(widget.getByTestId('properties-chip').first()).toBeHidden();

  // 占有は僅か: 畳んだトグルの高さは小さい (フル枠より明確に小さい)
  const box = await widget.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) expect(box.height).toBeLessThan(32);
});

test('[AC-S87f4b7-1-2] `>` で枠・ヘッダ無しのミニマル2カラム密行に展開し、`v` で畳める', async ({
  page,
}) => {
  await putNote(
    'layout/expand.md',
    ['---', 'status: 進行中', 'rating: 3', '---', '', 'アンカー行。', ''].join('\n'),
  );
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'layout/expand.md', 'アンカー行');

  const widget = page.getByTestId('properties-widget');
  const collapsedBox = await widget.boundingBox();

  // クリックで展開 (data-open=true)
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');

  // ミニマル2カラム密行: キー(型アイコン + キー名)と値
  const statusRow = widget.locator('[data-testid="properties-row"][data-key="status"]');
  await expect(statusRow).toBeVisible();
  await expect(statusRow).toContainText('進行中');
  // status→select, rating→star の意味型アイコンがキー側に付く
  await expect(widget.locator('[data-testid="properties-key"]').first()).toBeVisible();
  // rating は star 描画 (5 個の星ボタン)
  const stars = widget.locator(
    '[data-testid="properties-row"][data-key="rating"] .pc-star',
  );
  await expect(stars).toHaveCount(5);

  // 展開時は畳み時より背が高い (密行が見える)
  const expandedBox = await widget.boundingBox();
  expect(collapsedBox).not.toBeNull();
  expect(expandedBox).not.toBeNull();
  if (collapsedBox !== null && expandedBox !== null) {
    expect(expandedBox.height).toBeGreaterThan(collapsedBox.height);
  }

  // `v` (同じトグル) で再度畳める
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expect(statusRow).toBeHidden();
});

test('[AC-S87f4b7-1-3] 展開時の『+ プロパティを追加』で追加でき、畳み状態はノート切替でも保たれる', async ({
  page,
}) => {
  // frontmatter 無しのノート
  await putNote('layout/none.md', '本文のみ。\n');
  // 別ノート (畳み状態保持の確認用)
  await putNote(
    'layout/other.md',
    ['---', 'status: x', '---', '', '別ノート本文。', ''].join('\n'),
  );
  await page.goto(state().uiUrl);

  // frontmatter 無しノート: スラッシュメニューで frontmatter を生成 → 型ピッカーで追加
  await openNoteFromTree(page, 'layout/none.md', '本文のみ');
  await editorLine(page, '本文のみ').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/prop');
  await page.locator('[data-testid="slash-item"][data-command="properties"]').click();
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();

  // 展開して『+ プロパティを追加』(型ピッカー) から number を追加
  await widget.getByTestId('properties-toggle').click();
  await expect(widget).toHaveAttribute('data-open', 'true');
  await page.getByTestId('properties-add').click();
  await expect(page.getByTestId('property-add-menu')).toBeVisible();
  // キーファースト: 新規キー『ページ数』を汎用型 number で作成 (Sd13ab1-2)
  await page.getByTestId('property-add-filter').fill('ページ数');
  await page.getByTestId('property-add-new').click();
  await page.locator('[data-testid="property-new-type"][data-type="number"]').click();
  const pageRow = page.locator('[data-testid="properties-row"][data-key="ページ数"]');
  await expect(pageRow).toBeVisible();
  await pageRow.getByTestId('properties-value-body').click();
  const pageInput = pageRow.getByTestId('properties-value-input');
  await pageInput.fill('336');
  await pageInput.press('Enter');
  await editorLine(page, '本文のみ').click();
  await save(page);
  const file = await readVaultFile('layout/none.md');
  // frontmatter が生成され、標準 YAML スカラーで追記される
  expect(file.startsWith('---\n')).toBe(true);
  expect(file).toContain('ページ数: 336');

  // 畳み状態はノート切替でも妥当に保たれる: none.md は開いた状態
  // → other.md (既定畳み) へ切替 → none.md へ戻ると開いたまま
  await openNoteFromTree(page, 'layout/other.md', '別ノート本文');
  await expect(page.getByTestId('properties-widget')).toHaveAttribute('data-open', 'false');
  await openNoteFromTree(page, 'layout/none.md', '本文のみ');
  await expect(page.getByTestId('properties-widget')).toHaveAttribute('data-open', 'true');
});
