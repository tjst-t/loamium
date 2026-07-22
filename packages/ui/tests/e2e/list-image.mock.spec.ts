/**
 * Story S6848dc-2 mock テスト — リスト項目内に埋め込んだ画像を表示する。
 *
 * 箇条書き / 番号付きリスト項目内の `![alt](path)` がインライン画像として描画され、
 * リストマーカー装飾 (ドット / 番号) や ぶら下げライン装飾 (S6848dc-1) と同一行内で
 * 共存すること、カーソルが当該行に入るとソース記法へ戻ること (既存ライブプレビュー挙動)、
 * モバイル幅でも画像が親幅を超えないことを検証する。すべて表示層のみ (ピュア Markdown 不変)。
 *
 * page.route で全 /api/* をモックする。実サーバー不要 (決定的)。画像は data URI 相当の
 * 1px PNG を /api/files/** へ返す。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

// vault 内相対パスの画像 (assets/) と、添付一覧で basename から解決させたい画像。
const REL_IMG = 'assets/pic.png';
const CONTENT = [
  '# 見出し行',
  '',
  `段落画像: ![段落](${REL_IMG})`,
  '',
  `- 箇条書き項目 ![箇条](${REL_IMG}) のあとにテキスト`,
  `1. 番号付き項目 ![番号](${REL_IMG})`,
  `    - ネスト項目 ![ネスト](${REL_IMG})`,
  '',
].join('\n');

// 1x1 透明 PNG (base64)。/api/files/** の応答本体に使う。
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

async function openJournal(page: Page, viewport?: { width: number; height: number }): Promise<string[]> {
  if (viewport !== undefined) await page.setViewportSize(viewport);
  const unexpected = await installCatchAll(page);
  // /api/files/** の画像配信 (末尾に拡張子があるパス)。一覧 (/api/files) は catch-all の空既定を使う。
  await page.route('**/api/files/**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(PNG_1x1, 'base64'),
    });
  });
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal*', (route) => {
    void route.fulfill(json(journal(CONTENT)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('見出し行');
  return unexpected;
}

function line(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

test('[MOCK] 箇条書き / 番号付き / ネスト リスト項目内の ![](...) がインライン画像として描画される (AC-1/AC-3)', async ({ page }) => {
  const unexpected = await openJournal(page);
  // カーソルを見出し行に置く → リスト行はすべて装飾表示 (非アクティブ)。
  await line(page, '見出し行').click();

  // 画像は段落 1 + 箇条書き 1 + 番号付き 1 + ネスト 1 = 4 枚描画される。
  const images = page.getByTestId('embed-image');
  await expect(images).toHaveCount(4);

  // 箇条書き行: 装飾ドット (•) と 画像 widget が同一 .cm-line 内に共存する (AC-3)。
  const bulletLine = line(page, '箇条書き項目');
  await expect(bulletLine).toHaveClass(/cm-list-line/); // ぶら下げ装飾 (S6848dc-1) も共存
  await expect(bulletLine.locator('.cm-list-bullet')).toHaveText('•');
  await expect(bulletLine.locator('[data-testid="embed-image"] img')).toBeVisible();

  // 番号付き行: 採番マーカー (1.) と 画像 widget が共存する (AC-3)。
  const orderedLine = line(page, '番号付き項目');
  await expect(orderedLine).toContainText('1.');
  await expect(orderedLine.locator('[data-testid="embed-image"] img')).toBeVisible();

  // ネスト箇条書き行でも画像が描画される。
  const nestedLine = line(page, 'ネスト項目');
  await expect(nestedLine.locator('[data-testid="embed-image"] img')).toBeVisible();

  expect(unexpected).toEqual([]);
});

test('[MOCK] リスト行にカーソルを置くとソース記法に戻り、外すと画像へ戻る (AC-2)', async ({ page }) => {
  const unexpected = await openJournal(page);
  await line(page, '見出し行').click();
  await expect(page.getByTestId('embed-image')).toHaveCount(4);

  // 見出し行 → ↓↓ で箇条書きリスト行へカーソルを移す (widget は contenteditable=false のため
  // クリックではなくキーボードで確実に行内へ入れる)。
  await page.keyboard.press('ArrowDown'); // 空行
  await page.keyboard.press('ArrowDown'); // 段落画像行
  await page.keyboard.press('ArrowDown'); // 空行
  await page.keyboard.press('ArrowDown'); // 箇条書きリスト行

  // アクティブ行は素の Markdown 記法 (![箇条](assets/pic.png)) を表示する。
  const active = page.locator('[data-testid="editor"] .cm-activeLine').first();
  await expect(active).toContainText('![箇条](assets/pic.png)');
  // その行の画像 widget は消える → 残りは 3 枚 (段落 + 番号付き + ネスト)。
  await expect(page.getByTestId('embed-image')).toHaveCount(3);

  // カーソルを見出し行へ戻すと画像プレビューに戻る (4 枚)。
  await line(page, '見出し行').click();
  await expect(page.getByTestId('embed-image')).toHaveCount(4);

  expect(unexpected).toEqual([]);
});

test('[MOCK][mobile] モバイル幅でもリスト内画像が親幅を超えず横スクロールしない (AC-4)', async ({ page }) => {
  const unexpected = await openJournal(page, { width: 375, height: 700 });
  await line(page, '見出し行').click();
  await expect(page.getByTestId('embed-image')).toHaveCount(4);

  // 箇条書きリスト行の画像 wrap が行の右端を超えない (親幅内に収まる)。
  const overflow = await line(page, '箇条書き項目').evaluate((el) => {
    const lineRect = el.getBoundingClientRect();
    const wrap = el.querySelector('[data-testid="embed-image"]');
    if (wrap === null) return { hasImage: false, overflowRight: 0, overflowLeft: 0 };
    const wr = wrap.getBoundingClientRect();
    return {
      hasImage: true,
      overflowRight: Math.round(wr.right - lineRect.right),
      overflowLeft: Math.round(lineRect.left - wr.left),
    };
  });
  expect(overflow.hasImage).toBe(true);
  expect(overflow.overflowRight).toBeLessThanOrEqual(1); // 右にはみ出さない
  expect(overflow.overflowLeft).toBeLessThanOrEqual(1); // 左にもはみ出さない

  // エディタ本文 (cm-scroller) が横スクロールしていない (block widget 前例の回帰防止)。
  const noHScroll = await page
    .locator('[data-testid="editor"] .cm-scroller')
    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(noHScroll).toBe(true);

  expect(unexpected).toEqual([]);
});
