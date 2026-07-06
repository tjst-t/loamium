/**
 * Story S9df823-1「プロパティブロック表示と編集」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * 保存後の実ファイル読取で「標準 YAML frontmatter のまま (独自記法・制御文字なし、
 * Obsidian 互換)」を検証する (priority 1 / 4)。
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
  await page.goto(state().uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(waitText);
}

/**
 * 再設計後 (S87f4b7-1) は既定で畳まれているため、密行を見るには開く。
 * トグルはノート単位で状態を保持するので、以後の再構築でも開いたまま。
 */
async function expandProps(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  if ((await widget.getAttribute('data-open')) !== 'true') {
    await widget.getByTestId('properties-toggle').click();
    await expect(widget).toHaveAttribute('data-open', 'true');
  }
}

/** 型ピッカー経由で新プロパティを追加する (S87f4b7-3 の新規追加フロー)。 */
async function addPropertyViaPicker(
  page: Page,
  type: string,
  key: string,
  value: string,
): Promise<void> {
  await page.getByTestId('properties-add').click();
  await expect(page.getByTestId('property-type-picker')).toBeVisible();
  await page.locator(`[data-testid="property-type-option"][data-type="${type}"]`).first().click();
  await page.getByTestId('properties-new-key').fill(key);
  await page.getByTestId('properties-new-value').fill(value);
  await page.keyboard.press('Enter');
}

async function readVaultFile(rel: string): Promise<string> {
  return readFile(path.join(state().vault, rel), 'utf8');
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

/** ファイルが Obsidian 互換のクリーンなテキストであること (独自記法・制御文字なし)。 */
function expectCleanMarkdown(file: string): void {
  // eslint-disable-next-line no-control-regex
  expect(file).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  expect(file).not.toMatch(/\^[A-Za-z0-9]{6}/);
  expect(file).not.toContain('id::');
}

test('[AC-S9df823-1-1] カーソルが frontmatter 外のとき、プロパティブロック (tags はチップ) が描画される', async ({
  page,
}) => {
  const source = 'props/render.md';
  await putNote(
    source,
    [
      '---',
      'tags: [sample-project, infra]',
      'status: 進行中',
      'priority: 1',
      'created: 2026-06-01',
      '---',
      '',
      '# プロジェクト',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await openNoteFromTree(page, source, 'アンカー行');

  // 開いた直後 (初期カーソルは本文先頭 = frontmatter 外) から widget が見える。
  // 既定は畳まれており、本文直前に `>` トグルのみ (要約テキスト無し — AC-S87f4b7-1-1)
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expect(widget.getByTestId('properties-toggle')).toBeVisible();
  await expandProps(page);
  await expect(widget.getByTestId('properties-row')).toHaveCount(4);
  await expect(widget.locator('[data-testid="properties-row"][data-key="status"]')).toContainText(
    '進行中',
  );
  await expect(widget.locator('[data-testid="properties-row"][data-key="priority"]')).toContainText('1');
  // tags 配列はチップ表示
  await expect(widget.locator('[data-testid="properties-chip"]')).toHaveCount(2);
  await expect(
    widget.locator('[data-testid="properties-chip"][data-value="sample-project"]'),
  ).toBeVisible();
  // 生の YAML テキストは本文に見えない
  await expect(page.getByTestId('editor')).not.toContainText('tags: [sample-project, infra]');

  // カーソルを frontmatter 内へ移す (ソースを編集) と生 YAML、外へ戻すと widget
  await widget.hover();
  await page.getByTestId('properties-edit-source').click();
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('tags: [sample-project, infra]');
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('properties-widget')).toBeVisible();
});

test('[AC-S9df823-1-2] 値のその場編集・tags チップの追加削除が標準 YAML としてファイルに書き戻される', async ({
  page,
}) => {
  const source = 'props/edit.md';
  await putNote(
    source,
    [
      '---',
      'tags: [alpha, beta]',
      'status: 進行中',
      'priority: 1',
      'code: "5"',
      '---',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await openNoteFromTree(page, source, 'アンカー行');
  await expandProps(page);

  // 引用符付き文字列 "5" を開いて何も変えずにフォーカスを外す → 型が化けない
  // (blur コミット経路で素朴な型解釈が走らないことの回帰テスト)
  await page
    .locator('[data-testid="properties-row"][data-key="code"]')
    .getByTestId('properties-value-body')
    .click();
  await expect(page.getByTestId('properties-value-input')).toBeFocused();
  await editorLine(page, 'アンカー行').click();

  // テキスト値のその場編集 (日本語値 — IME 経路のテキスト入力)
  const statusRow = page.locator('[data-testid="properties-row"][data-key="status"]');
  await statusRow.getByTestId('properties-value-body').click();
  const input = page.getByTestId('properties-value-input');
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('完了');
  await page.keyboard.press('Enter');
  await expect(
    page
      .locator('[data-testid="properties-row"][data-key="status"]')
      .getByTestId('properties-value-body'),
  ).toHaveText('完了');

  // tags チップの追加 (Enter) と削除 (×)
  await page.getByTestId('properties-widget').getByTestId('properties-chip-input').click();
  await page.keyboard.type('gamma');
  await page.keyboard.press('Enter');
  await editorLine(page, 'アンカー行').click(); // フォーカスを外してコミット
  await page
    .locator('[data-testid="properties-chip-remove"][data-value="alpha"]')
    .click();
  await expect(
    page.getByTestId('properties-widget').locator('[data-testid="properties-chip"]'),
  ).toHaveCount(2);

  // 保存 → 実ファイルは標準 YAML frontmatter
  await editorLine(page, 'アンカー行').click();
  await save(page);
  const file = await readVaultFile(source);
  expect(file.startsWith('---\n')).toBe(true);
  expect(file).toContain('status: 完了');
  expect(file).toContain('- beta');
  expect(file).toContain('- gamma');
  expect(file).not.toContain('alpha');
  expect(file).toContain('priority: 1'); // 未編集キーは保たれる
  expect(file).toContain('code: "5"'); // 無変更で開閉した引用符付き文字列は原文のまま
  expect(file).toContain('アンカー行。'); // 本文は無傷
  expectCleanMarkdown(file);
});

test('[AC-S9df823-1-3] プロパティの追加・削除ができ、スラッシュメニュー『プロパティ』で frontmatter が生成される', async ({
  page,
}) => {
  const source = 'props/add.md';
  await putNote(source, ['---', 'status: x', '---', '', 'アンカー行。', ''].join('\n'));
  await openNoteFromTree(page, source, 'アンカー行');
  await expandProps(page);

  // 展開時の末尾『+ プロパティを追加』→ 型ピッカーで number を選んで追加 (AC-S87f4b7-1-3 / -3-2)
  await addPropertyViaPicker(page, 'number', 'rating', '5');
  await expect(page.locator('[data-testid="properties-row"][data-key="rating"]')).toBeVisible();
  await editorLine(page, 'アンカー行').click();
  await save(page);
  let file = await readVaultFile(source);
  expect(file).toContain('rating: 5');
  expectCleanMarkdown(file);

  // 全プロパティ削除 → frontmatter ブロック自体が除去される
  while ((await page.locator('[data-testid="properties-del"]').count()) > 0) {
    await page.locator('[data-testid="properties-del"]').first().click();
  }
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await editorLine(page, 'アンカー行').click();
  await save(page);
  file = await readVaultFile(source);
  expect(file.startsWith('---')).toBe(false);
  expect(file).not.toContain('---');
  expect(file).toContain('アンカー行。');
  expectCleanMarkdown(file);

  // frontmatter 無しノートにスラッシュメニュー『プロパティ』で frontmatter を生成
  const source2 = 'props/slash.md';
  await putNote(source2, '本文のみ。\n');
  await openNoteFromTree(page, source2, '本文のみ');
  await editorLine(page, '本文のみ').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/prop');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await page.locator('[data-testid="slash-item"][data-command="properties"]').click();
  await expect(page.getByTestId('properties-widget')).toBeVisible();
  await save(page);
  const file2 = await readVaultFile(source2);
  expect(file2.startsWith('---\ntags: []\n---\n')).toBe(true);
  expect(file2).toContain('本文のみ。');
  expect(file2).not.toContain('/prop');
  expectCleanMarkdown(file2);
});

test('[AC-S9df823-1-4] 『ソースを編集』で生 YAML 編集でき、複雑な値は読み取り専用でバイト単位に保たれる', async ({
  page,
}) => {
  const source = 'props/source.md';
  await putNote(
    source,
    [
      '---',
      'status: 進行中',
      'meta:',
      '  author: tjst',
      '  depth: 2',
      '---',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await openNoteFromTree(page, source, 'アンカー行');
  await expandProps(page);

  // ネストした複雑な値は読み取り専用表示 + ソースへの誘導
  const metaRow = page.locator('[data-testid="properties-row"][data-key="meta"]');
  await expect(metaRow.getByTestId('properties-value-readonly')).toBeVisible();

  // 『ソースを編集』→ 生 YAML が表示され、カーソルが frontmatter 内にある
  await page.getByTestId('properties-widget').hover();
  await page.getByTestId('properties-edit-source').click();
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('author: tjst');
  await expect(page.locator('[data-testid="editor"] .cm-activeLine')).toContainText('status: 進行中');

  // 生 YAML をソースとして直接編集する (行末に新しいキーを足す)
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('reviewed: true');
  await save(page);
  let file = await readVaultFile(source);
  expect(file).toContain('reviewed: true');
  expect(file).toContain('meta:\n  author: tjst\n  depth: 2');
  expectCleanMarkdown(file);

  // widget に戻り、別のキーを編集しても複雑な値の原文はバイト単位で保たれる
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('properties-widget')).toBeVisible();
  const statusRow = page.locator('[data-testid="properties-row"][data-key="status"]');
  await statusRow.getByTestId('properties-value-body').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('レビュー済み');
  await page.keyboard.press('Enter');
  await editorLine(page, 'アンカー行').click();
  await save(page);
  file = await readVaultFile(source);
  expect(file).toContain('status: レビュー済み');
  expect(file).toContain('meta:\n  author: tjst\n  depth: 2'); // 原文 verbatim
  expect(file.startsWith('---\n')).toBe(true);
  expectCleanMarkdown(file);
});
