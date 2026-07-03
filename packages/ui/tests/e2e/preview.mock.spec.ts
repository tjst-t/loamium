/**
 * Story S9ab6c3-2 mock テスト (ライブプレビューのエッジケース・エラーケース)。
 * page.route で全 /api/* をモックする (gui-spec-S9ab6c3-2.json 参照)。
 * 受け入れ条件の本検証は preview.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

function journal(content: string, mtime = 1000): Record<string, unknown> {
  return {
    date: DATE,
    path: JOURNAL_PATH,
    content,
    frontmatter: null,
    body: content,
    created: false,
    mtime,
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
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText(waitText);
  // 初期カーソルは 1 行目 (= その行はソース表示) なので、装飾の検証前に
  // 装飾と無関係な行へカーソルを移しておく
  await editorLine(page, waitText).click();
  return unexpected;
}

test('[MOCK] 不正な mermaid コードはフェンス内のエラー表示に留まり、エディタは編集可能なまま', async ({ page }) => {
  const content = ['最初の段落。', '', '```mermaid', 'これは mermaid ではない !!', '```', '', 'アンカー行。', ''].join('\n');
  const unexpected = await openWithJournal(page, content, 'アンカー行');

  // フェンス widget は出るが、中身はエラー表示 (svg 図ではない)
  const widget = page.locator('[data-testid="fence-widget"][data-lang="mermaid"]');
  await expect(widget).toBeVisible();
  await expect(widget.locator('.fence-render-error')).toBeVisible({ timeout: 20_000 });
  await expect(widget).toContainText('失敗');

  // アプリはクラッシュしておらず編集を継続できる
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 未登録言語のフェンスは fence-widget にならずソース表示のまま', async ({ page }) => {
  const content = ['```foolang', 'unknown language body', '```', '', 'アンカー行。', ''].join('\n');
  const unexpected = await openWithJournal(page, content, 'アンカー行');

  await expect(page.getByTestId('fence-widget')).toHaveCount(0);
  await expect(editorLine(page, '```foolang')).toBeVisible();
  await expect(editorLine(page, 'unknown language body')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 閉じられていない $$ ブロックは描画されずソース表示のまま', async ({ page }) => {
  const content = ['$$', 'x = 1', '', 'その後の段落。', ''].join('\n');
  const unexpected = await openWithJournal(page, content, 'その後の段落');

  await expect(page.getByTestId('math-block')).toHaveCount(0);
  await expect(editorLine(page, '$$')).toBeVisible();
  await expect(editorLine(page, 'x = 1')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] インラインコード内の $x$ と単独の $ (通貨表記) は数式にならない', async ({ page }) => {
  const content = [
    'コード内: `$x$ は変数`。',
    '',
    '価格は 5$ と 10$ です。',
    '',
    'ドル前置なら $5 と $10 のように書く。',
    '',
    '本物の数式 $y=x$ はこちら。',
    '',
    'アンカー行。',
    '',
  ].join('\n');
  const unexpected = await openWithJournal(page, content, 'アンカー行');

  // 本物の数式だけが math-inline になる
  await expect(page.getByTestId('math-inline')).toHaveCount(1);
  await expect(editorLine(page, '本物の数式')).not.toContainText('$y=x$');

  // インラインコード内はコードのまま ($x$ がテキストとして残る)
  await expect(editorLine(page, 'コード内')).toContainText('$x$ は変数');

  // 通貨表記の行はソースのまま (後置 $ も前置 $ も)
  await expect(editorLine(page, '価格は')).toContainText('5$ と 10$');
  await expect(editorLine(page, 'ドル前置なら')).toContainText('$5 と $10');
  expect(unexpected).toEqual([]);
});

test('[MOCK] $$x$$ 1 行ブロックは math-block として描画され、カーソルを置くとソースに戻る', async ({ page }) => {
  const content = ['$$E = mc^2$$', '', 'アンカー行。', ''].join('\n');
  const unexpected = await openWithJournal(page, content, 'アンカー行');

  const block = page.getByTestId('math-block');
  await expect(block).toBeVisible();
  await expect(block.locator('.katex').first()).toBeVisible();

  // ブロックをクリック → カーソルが移りソース表示に戻る
  await block.click();
  await expect(editorLine(page, '$$E = mc^2$$')).toBeVisible();
  await expect(page.getByTestId('math-block')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
