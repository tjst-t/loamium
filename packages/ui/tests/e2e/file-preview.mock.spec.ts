/**
 * Story Sf53ad6-3 mock テスト (埋め込みプレビューのエラー・エッジケース)。
 * page.route で全 /api/* をモックする (gui-spec-Sf53ad6-3.json 参照)。
 * 受け入れ条件の本検証は file-preview.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

interface FileMetaMock {
  path: string;
  size: number;
  mtime: number;
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

async function openJournalWith(
  page: Page,
  content: string,
  files: FileMetaMock[],
  /** GET /api/files/{path} の応答 (goto より前に登録する — 初回描画分も受ける) */
  serveFile?: Parameters<Page['route']>[1],
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({
        date: DATE,
        path: JOURNAL_PATH,
        content,
        frontmatter: null,
        body: content,
        created: false,
        mtime: 1000,
      }),
    );
  });
  await page.route('**/api/files', (route) => void route.fulfill(json({ files })));
  if (serveFile !== undefined) {
    await page.route('**/api/files/assets/**', serveFile);
  }
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('アンカー行');
  await editorLine(page, 'アンカー行').click();
  return unexpected;
}

test('[MOCK] テキスト取得の失敗 (500) はブロック内エラーに留まり、エディタは操作可能', async ({ page }) => {
  const unexpected = await openJournalWith(
    page,
    '![[assets/server.log]]\n\nアンカー行。\n',
    [{ path: 'assets/server.log', size: 100, mtime: 1 }],
    (route) => {
      void route.fulfill(json({ error: 'io_error', message: 'disk unavailable' }, 500));
    },
  );

  const block = page.locator(
    '[data-testid="file-embed"][data-kind="text"][data-path="assets/server.log"]',
  );
  await expect(block).toBeVisible();
  await expect(block).toContainText('テキストを読み込めませんでした');
  await expect(block).toHaveAttribute('data-error', 'true');
  // エディタはクラッシュしていない
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 添付一覧に無いプレビュー不能ファイルはカードに「見つかりません」を出す', async ({ page }) => {
  const unexpected = await openJournalWith(page, '![[assets/missing.zst]]\n\nアンカー行。\n', []);

  const card = page.locator(
    '[data-testid="file-embed"][data-kind="card"][data-path="assets/missing.zst"]',
  );
  await expect(card).toBeVisible();
  await expect(card).toContainText('ファイルが見つかりません');
  await expect(card).toHaveAttribute('data-error', 'true');
  // 存在しないので本体フェッチは飛ばない (unexpected が空)
  expect(unexpected).toEqual([]);
});

test('[MOCK] 長いテキストは先頭 30 行 + 「全体を開く」で、開くと全行が展開される', async ({ page }) => {
  const total = 100;
  const body = Array.from({ length: total }, (_, i) => `line-${String(i + 1)}`).join('\n');
  const unexpected = await openJournalWith(
    page,
    '![[assets/long.log]]\n\nアンカー行。\n',
    [{ path: 'assets/long.log', size: body.length, mtime: 1 }],
    (route) => {
      void route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body });
    },
  );

  const block = page.locator('[data-testid="file-embed"][data-path="assets/long.log"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText('100 行 · 先頭 30 行を表示');
  await expect(block).toContainText('line-1');
  await expect(block).toContainText('line-30');
  await expect(block).not.toContainText('line-31');

  const openFull = block.getByTestId('file-embed-open-full');
  await expect(openFull).toContainText('全体を開く(残り 70 行)');
  await openFull.click();
  await expect(block).toHaveAttribute('data-expanded', 'true');
  await expect(block).toContainText('line-100');
  await expect(block).toContainText('全 100 行');
  await expect(openFull).toHaveCount(0); // ボタンは役目を終えて消える
  expect(unexpected).toEqual([]);
});

test('[MOCK] PDF ブロックは iframe (ブラウザ内蔵ビューア) で、フッターから新しいタブを開ける', async ({ page }) => {
  const unexpected = await openJournalWith(
    page,
    '![[assets/report.pdf]]\n\nアンカー行。\n',
    [{ path: 'assets/report.pdf', size: 1258291, mtime: 1 }],
    (route) => {
      void route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF\n' });
    },
  );

  const block = page.locator(
    '[data-testid="file-embed"][data-kind="pdf"][data-path="assets/report.pdf"]',
  );
  await expect(block).toBeVisible();
  await expect(block).toContainText('1.2 MB'); // 添付一覧からのサイズ表示
  await expect(block.locator('iframe.pdf-frame')).toHaveAttribute(
    'src',
    '/api/files/assets/report.pdf',
  );
  const openFull = block.getByTestId('file-embed-open-full');
  await expect(openFull).toContainText('新しいタブで開く');
  const popupPromise = page.waitForEvent('popup');
  await openFull.click();
  const popup = await popupPromise;
  expect(popup.url()).toContain('/api/files/assets/report.pdf');
  expect(unexpected).toEqual([]);
});

test('[MOCK] コード拡張子 (.json) は Shiki ハイライト付きの読み取り専用ブロックになる', async ({ page }) => {
  const body = '{\n  "name": "loamium",\n  "mode": "full"\n}\n';
  const unexpected = await openJournalWith(
    page,
    '![[assets/config.json]]\n\nアンカー行。\n',
    [{ path: 'assets/config.json', size: body.length, mtime: 1 }],
    (route) => {
      void route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body });
    },
  );

  const block = page.locator(
    '[data-testid="file-embed"][data-kind="text"][data-path="assets/config.json"]',
  );
  await expect(block).toBeVisible();
  await expect(block).toContainText('全 4 行');
  // Shiki の出力 (pre.shiki) が入る = シンタックスハイライト
  await expect(block.locator('pre.shiki')).toBeVisible();
  await expect(block).toContainText('"loamium"');
  expect(unexpected).toEqual([]);
});
