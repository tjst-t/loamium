/**
 * Story S9df823-1 mock テスト (frontmatter プロパティ UI)。
 * page.route で全 /api/* をモックし、UI 挙動 (プロパティブロック描画・値編集・
 * チップ追加削除・プロパティ追加削除・複雑値フォールバック・スラッシュメニュー) を
 * 実ブラウザで固める。受け入れ条件の本検証 (実ファイル書込) は
 * properties.e2e.spec.ts が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime: 1000,
  };
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openWithJournal(page: Page, content: string, waitText: string): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(content)));
  });
  await page.route(`**/api/notes/journals/**`, (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fulfill(json(journal(content)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  return unexpected;
}

/** 再設計後 (S87f4b7-1) は既定で畳まれているため、密行を見るには開く。 */
async function expandProps(page: Page): Promise<void> {
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  if ((await widget.getAttribute('data-open')) !== 'true') {
    await widget.getByTestId('properties-toggle').click();
    await expect(widget).toHaveAttribute('data-open', 'true');
  }
}

const FM_NOTE = [
  '---',
  'tags: [alpha, beta]',
  'status: 進行中',
  'priority: 2',
  'published: false',
  'created: 2026-06-01',
  '---',
  '',
  '# 見出し',
  '',
  'アンカー行。',
  '',
].join('\n');

test('[MOCK] frontmatter がプロパティブロックとして描画され、tags はチップ表示になる', async ({
  page,
}) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  // 初期カーソルは本文先頭 (frontmatter 外) — 開いた直後から widget が見える。
  // 既定は畳まれており `>` トグルのみ (S87f4b7-1)。開くと密行が見える。
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  await expect(widget).toHaveAttribute('data-open', 'false');
  await expandProps(page);
  await expect(widget.getByTestId('properties-row')).toHaveCount(5);
  await expect(widget.locator('[data-testid="properties-row"][data-key="status"]')).toContainText(
    '進行中',
  );
  await expect(widget.locator('[data-testid="properties-chip"]')).toHaveCount(2);
  await expect(widget.locator('[data-testid="properties-chip"][data-value="alpha"]')).toBeVisible();
  // 生 YAML (--- / tags:) はエディタ本文に見えない
  await expect(page.getByTestId('editor')).not.toContainText('tags: [alpha, beta]');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 『ソースを編集』で生 YAML 表示へ切り替わり、カーソルが frontmatter に入る', async ({
  page,
}) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await expandProps(page);
  const widget = page.getByTestId('properties-widget');
  await widget.hover();
  await page.getByTestId('properties-edit-source').click();

  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('tags: [alpha, beta]');
  await expect(page.locator('[data-testid="editor"] .cm-activeLine')).toContainText(
    'tags: [alpha, beta]',
  );
  // カーソルを frontmatter 外へ戻すと widget が復活する
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('properties-widget')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 値をクリックすると input 編集になり、Esc で取り消せる', async ({ page }) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await expandProps(page);
  const row = page.locator('[data-testid="properties-row"][data-key="status"]');
  await row.getByTestId('properties-value-body').click();
  const input = page.getByTestId('properties-value-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('進行中');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('やめる');
  await page.keyboard.press('Escape');
  await expect(row.getByTestId('properties-value-body')).toHaveText('進行中');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 値編集を Enter で確定すると表示が更新される (日本語値)', async ({ page }) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await expandProps(page);
  const row = page.locator('[data-testid="properties-row"][data-key="status"]');
  await row.getByTestId('properties-value-body').click();
  const input = page.getByTestId('properties-value-input');
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('完了です');
  await page.keyboard.press('Enter');
  await expect(
    page
      .locator('[data-testid="properties-row"][data-key="status"]')
      .getByTestId('properties-value-body'),
  ).toHaveText('完了です');
  expect(unexpected).toEqual([]);
});

test('[MOCK] チップを Enter で連続追加でき、× で削除できる', async ({ page }) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await expandProps(page);
  const widget = page.getByTestId('properties-widget');
  await widget.getByTestId('properties-chip-input').click();
  await page.keyboard.type('gamma');
  await page.keyboard.press('Enter');
  // コミット前でもチップは即時表示され、入力は空のままフォーカスが残る (連続追加)
  await expect(widget.locator('[data-testid="properties-chip"]')).toHaveCount(3);
  await expect(widget.getByTestId('properties-chip-input')).toBeFocused();
  await expect(widget.getByTestId('properties-chip-input')).toHaveValue('');

  // フォーカスを外すとコミットされ、再構築後もチップが残る
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('properties-widget').locator('[data-testid="properties-chip"]')).toHaveCount(3);

  // × で削除 → 即コミットされチップが減る
  await page
    .locator('[data-testid="properties-chip-remove"][data-value="alpha"]')
    .click();
  await expect(
    page.getByTestId('properties-widget').locator('[data-testid="properties-chip"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="properties-chip"][data-value="alpha"]'),
  ).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 真偽値はチェックボックスで切り替えられる', async ({ page }) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await expandProps(page);
  const cb = page.locator('[data-testid="properties-bool"][data-key="published"]');
  await expect(cb).not.toBeChecked();
  await cb.click();
  await expect(page.locator('[data-testid="properties-bool"][data-key="published"]')).toBeChecked();
  expect(unexpected).toEqual([]);
});

test('[MOCK] キーファースト追加: 既存キーは無効・既知キーは即追加される', async ({ page }) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await expandProps(page);
  // 追加ボタン → キーファースト候補メニューが開く (Sd13ab1-2)
  await page.getByTestId('properties-add').click();
  await expect(page.getByTestId('property-add-menu')).toBeVisible();

  // この文書に既にある status は候補で無効 (一意なので重複不可)
  await page.getByTestId('property-add-filter').fill('status');
  const statusOpt = page.locator('[data-testid="property-add-known"][data-key="status"]');
  await expect(statusOpt).toHaveAttribute('data-existing', 'true');
  await expect(statusOpt).toBeDisabled();

  // 既知/一意キー rating を選ぶ → キー名の再入力なしに即追加。型は D方式で star に解決
  await page.getByTestId('property-add-filter').fill('rating');
  await page.locator('[data-testid="property-add-known"][data-key="rating"]').click();
  const newRow = page.locator('[data-testid="properties-row"][data-key="rating"]');
  await expect(newRow).toBeVisible();
  await expect(newRow.locator('[data-type="star"]')).toBeVisible();
  await expect(page.getByTestId('properties-row')).toHaveCount(6);
  expect(unexpected).toEqual([]);
});

test('[MOCK] 全プロパティを削除すると frontmatter ブロック自体が消える', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['---', 'status: x', 'priority: 1', '---', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await expandProps(page);
  await expect(page.getByTestId('properties-row')).toHaveCount(2);
  const firstDel = () => page.locator('[data-testid="properties-row-delete"]').first();
  await firstDel().click();
  await expect(page.getByTestId('properties-row')).toHaveCount(1);
  await firstDel().click();
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).not.toContainText('---');
  expect(unexpected).toEqual([]);
});

test('[MOCK] ネストした複雑な値は読み取り専用になり、クリックでソースへ誘導される', async ({
  page,
}) => {
  const unexpected = await openWithJournal(
    page,
    ['---', 'status: x', 'meta:', '  author: tjst', '  depth: 2', '---', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await expandProps(page);
  const metaRow = page.locator('[data-testid="properties-row"][data-key="meta"]');
  await expect(metaRow.getByTestId('properties-value-readonly')).toBeVisible();
  // 複雑値の行には編集 input は無い — クリックするとソース表示へ切り替わる
  await metaRow.getByTestId('properties-value-readonly').click();
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('author: tjst');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 壊れた YAML の frontmatter は widget 化せず生ソース表示のまま', async ({ page }) => {
  const unexpected = await openWithJournal(
    page,
    ['---', 'title: [', '---', '', 'アンカー行。', ''].join('\n'),
    'アンカー行',
  );
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('properties-widget')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('title: [');
  expect(unexpected).toEqual([]);
});

test('[MOCK] スラッシュメニューの『プロパティ』で frontmatter 無しノートに frontmatter が生成される', async ({
  page,
}) => {
  const unexpected = await openWithJournal(page, '本文のみのノート。\n', '本文のみのノート');
  await editorLine(page, '本文のみのノート').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/prop');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  const item = page.locator('[data-testid="slash-item"][data-command="properties"]');
  await expect(item).toBeVisible();
  await item.click();

  // 文書冒頭に frontmatter が生成され、プロパティブロックとして描画される (既定は畳み)
  const widget = page.getByTestId('properties-widget');
  await expect(widget).toBeVisible();
  await expandProps(page);
  await expect(widget.locator('[data-testid="properties-row"][data-key="tags"]')).toBeVisible();
  // /prop トークンは消えている
  await expect(page.getByTestId('editor')).not.toContainText('/prop');
  expect(unexpected).toEqual([]);
});

test('[MOCK] frontmatter が既にあるノートでは『プロパティ』が二重挿入しない', async ({ page }) => {
  const unexpected = await openWithJournal(page, FM_NOTE, 'アンカー行');
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/prop');
  await page.locator('[data-testid="slash-item"][data-command="properties"]').click();

  // widget は 1 つのまま、/prop も消える
  await expect(page.getByTestId('properties-widget')).toHaveCount(1);
  await expect(page.getByTestId('editor')).not.toContainText('/prop');
  expect(unexpected).toEqual([]);
});
