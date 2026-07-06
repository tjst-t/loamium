/**
 * Story Sd13ab1-2「キーファーストの追加フロー + vault横断サジェスト + 型永続化」
 * E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実 Loamium サーバー → 実 FS。
 * ビジュアルの正は prototype/props-redesign/chosen-v2.html (C/D 欄)。
 * 特に「他ファイルで作ったキーが別ファイルの追加メニューに出る」「新規キーの型が
 * property-types.json に永続化され別ファイルでその型に解決される」を実サーバーで検証する。
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

async function openNoteFromTree(page: Page, rel: string, waitText: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

async function expandAndOpenMenu(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  if ((await widget.getAttribute('data-open')) !== 'true') {
    await widget.getByTestId('properties-summary').click();
    await expect(widget).toHaveAttribute('data-open', 'true');
  }
  await widget.getByTestId('properties-add').click();
  await expect(page.getByTestId('property-add-menu')).toBeVisible();
}

test('[AC-Sd13ab1-2-1] 追加でキー候補メニューが開き、絞り込みできる。2ゾーン構成', async ({
  page,
}) => {
  await putNote('add/menu.md', ['---', 'tags: [a]', 'status: 読了', '---', '', 'アンカー行。', ''].join('\n'));
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'add/menu.md', 'アンカー行');
  await expandAndOpenMenu(page);

  const menu = page.getByTestId('property-add-menu');
  const filter = menu.getByTestId('property-add-filter');
  await expect(filter).toBeVisible();

  // 絞り込み: 'stat' → status 候補が出る (rating は出ない)
  await filter.fill('stat');
  await expect(menu.locator('[data-testid="property-add-known"][data-key="status"]')).toBeVisible();
  await expect(menu.locator('[data-testid="property-add-known"][data-key="rating"]')).toHaveCount(0);

  // 一致しない名前 → 『② 新規作成: 入力名』が末尾に出る
  await filter.fill('ゑゑ新規キーゑゑ');
  await expect(menu.getByTestId('property-add-new')).toBeVisible();
  await expect(menu.getByTestId('property-add-new')).toContainText('ゑゑ新規キーゑゑ');
});

test('[AC-Sd13ab1-2-2] 既知/一意キーは即追加 (型は D方式)、既存キーは候補で無効', async ({
  page,
}) => {
  await putNote('add/known.md', ['---', 'tags: [a]', 'status: 読了', '---', '', 'アンカー行。', ''].join('\n'));
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'add/known.md', 'アンカー行');
  await expandAndOpenMenu(page);

  const menu = page.getByTestId('property-add-menu');
  // この文書に既にある status / tags は候補で無効 (一意なので重複不可)
  await menu.getByTestId('property-add-filter').fill('status');
  const existing = menu.locator('[data-testid="property-add-known"][data-key="status"]');
  await expect(existing).toHaveAttribute('data-existing', 'true');
  await expect(existing).toBeDisabled();

  // 既知/一意キー rating を選ぶ → キー名再入力なしに即追加。型は D方式で star に解決
  await menu.getByTestId('property-add-filter').fill('rating');
  await menu.locator('[data-testid="property-add-known"][data-key="rating"]').click();
  const row = page.locator('[data-testid="properties-row"][data-key="rating"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.pc-star')).toHaveCount(5); // star 描画 (D方式)

  await editorLine(page, 'アンカー行').click();
  await save(page);
  const file = await readVaultFile('add/known.md');
  // 標準 YAML スカラーで書き戻る (star 既定値 0)。型情報はファイルに書かない
  expect(file).toContain('rating: 0');
  expect(file).not.toContain('type:');
});

test('[AC-Sd13ab1-2-3] 新規キー→汎用型選択で型が永続化され、別ファイルでその型に解決される', async ({
  page,
}) => {
  // どのノートにも存在しない一意な新規キー名 (共有 vault の他テストと衝突させない)
  const KEY = 'よみぷろぱてぃ';
  await putNote('add/b.md', ['---', 'status: x', '---', '', 'アンカー行B。', ''].join('\n'));
  await putNote('add/c.md', ['---', 'status: y', '---', '', 'アンカー行C。', ''].join('\n'));
  await page.goto(state().uiUrl);
  await openNoteFromTree(page, 'add/b.md', 'アンカー行B');
  await expandAndOpenMenu(page);

  const menu = page.getByTestId('property-add-menu');
  // 一致しない名前 → 新規作成 → 汎用型 star を選ぶ
  await menu.getByTestId('property-add-filter').fill(KEY);
  await menu.getByTestId('property-add-new').click();
  await expect(menu.getByTestId('property-new-type-wrap')).toBeVisible();
  await menu.locator('[data-testid="property-new-type"][data-type="star"]').click();

  const row = page.locator(`[data-testid="properties-row"][data-key="${KEY}"]`);
  await expect(row).toBeVisible();
  await editorLine(page, 'アンカー行B').click();
  await save(page);

  // note B は標準 YAML のまま (star 既定値 0、型情報なし)
  const fileB = await readVaultFile('add/b.md');
  expect(fileB).toContain(`${KEY}: 0`);
  expect(fileB).not.toContain('type:');

  // 型が .loamium/property-types.json に永続化された (D方式の横断固定)
  await expect
    .poll(async () => {
      const res = await fetch(`${state().apiUrl}/api/property-types`);
      const body = (await res.json()) as { types: Record<string, { type?: string }> };
      return body.types[KEY]?.type;
    })
    .toBe('star');

  // 別ファイル note C を開き、同じキーを追加すると star 型に解決される
  // (型は note B で永続化されており、別ファイルでも同じ型に固定される)
  await openNoteFromTree(page, 'add/c.md', 'アンカー行C');
  const widgetC = page.getByTestId('properties-widget');
  await widgetC.getByTestId('properties-summary').click();
  await expect(widgetC).toHaveAttribute('data-open', 'true');
  await widgetC.getByTestId('properties-add').click();
  const menuC = page.getByTestId('property-add-menu');
  await expect(menuC).toBeVisible();
  await menuC.getByTestId('property-add-filter').fill(KEY);
  // 永続化済みキーは既知候補として出る (vault + JSON定義)
  await menuC.locator(`[data-testid="property-add-known"][data-key="${KEY}"]`).click();
  await expect(
    widgetC.locator(`[data-testid="properties-row"][data-key="${KEY}"] .pc-star`),
  ).toHaveCount(5);
});

test('[AC-Sd13ab1-2-1] 他ファイルで作ったキー(hoge)が別ファイルの追加メニューにサジェストされる', async ({
  page,
}) => {
  // note A で独自キー hoge を作成 (実サーバーの index に集約される)
  await putNote('add/withhoge.md', ['---', 'hoge: 42', '---', '', 'アンカー行H。', ''].join('\n'));
  // note B には hoge は無い
  await putNote('add/nohoge.md', ['---', 'status: x', '---', '', 'アンカー行N。', ''].join('\n'));
  await page.goto(state().uiUrl);

  // note B の追加メニューで hoge が候補に出る (vault 横断サジェスト)
  await openNoteFromTree(page, 'add/nohoge.md', 'アンカー行N');
  await expandAndOpenMenu(page);
  const menu = page.getByTestId('property-add-menu');
  await menu.getByTestId('property-add-filter').fill('hoge');
  await expect(menu.locator('[data-testid="property-add-known"][data-key="hoge"]')).toBeVisible();

  // 選ぶと即追加され、標準 YAML に書き戻る
  await menu.locator('[data-testid="property-add-known"][data-key="hoge"]').click();
  await expect(page.locator('[data-testid="properties-row"][data-key="hoge"]')).toBeVisible();
});
