/**
 * Story S6848dc-2 review mock テスト — インライン ![[image]] (Obsidian wiki 埋め込み記法)。
 *
 * 実機レビューで判明したバグの回帰防止: テキストと同じ行にある `![[assets/pic.png]]`
 * (リスト項目・段落) が、赤い「未解決リンク」(wikilink-broken) ではなく
 * インライン画像 (embed-image) として描画されること。
 *
 * 併せて回帰: 標準記法 ![](path)、通常の [[存在するノート]] wikilink、
 * [[存在しないノート]] の broken 表示が壊れていないことを確認する。
 * すべて表示層のみ (ピュア Markdown 不変)。実サーバー不要 (page.route で決定的)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

const REL_IMG = 'assets/pic.png';

// 既存ノート ([[存在するノート]] の解決先) と、埋め込み画像を混ぜた本文。
const EXISTING_NOTE = 'メモ帳.md';
const CONTENT = [
  '# 見出し行',
  '',
  // 段落内インライン wiki 埋め込み (テキスト混在)
  `段落: ![[${REL_IMG}]] のあとにテキスト`,
  '',
  // 箇条書き項目内 wiki 埋め込み
  `- 手順: ![[${REL_IMG}]] を確認`,
  // 番号付き項目内
  `1. 番号: ![[${REL_IMG}]]`,
  // ネスト
  `    - ネスト: ![[${REL_IMG}]]`,
  '',
  // 標準記法 (回帰) と 通常 wikilink (解決あり / 壊れ) を同居させる
  `標準: ![標準](${REL_IMG})`,
  `リンク: [[メモ帳]] と [[存在しないノート]]。`,
  '',
].join('\n');

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
  // /api/files/** の画像配信 (末尾に拡張子があるパス)。フルパス assets/pic.png を 200 で返す。
  await page.route('**/api/files/**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(PNG_1x1, 'base64'),
    });
  });
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({
        notes: [
          { path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' },
          { path: EXISTING_NOTE, title: 'メモ帳', tags: [], folder: '' },
        ],
      }),
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

test('[MOCK] 段落・箇条書き・番号付き・ネストのインライン ![[assets/pic.png]] が画像描画され赤リンクにならない', async ({ page }) => {
  const unexpected = await openJournal(page);
  await line(page, '見出し行').click(); // 全行を装飾表示 (非アクティブ) にする

  // ![[...]] 4 箇所 + 標準 ![](path) 1 箇所 = embed-image は 5 枚。
  await expect(page.getByTestId('embed-image')).toHaveCount(5);

  // インライン ![[...]] が内側 [[...]] を broken 赤リンクにしていないこと (真因の回帰)。
  await expect(page.getByTestId('wikilink-broken')).toHaveCount(1); // [[存在しないノート]] のみ

  // 段落行: テキストと画像が同一 .cm-line 内で共存する。
  const para = line(page, '段落:');
  await expect(para.locator('[data-testid="embed-image"] img')).toBeVisible();
  await expect(para).toContainText('のあとにテキスト');

  // 箇条書き項目内: 装飾ドットと画像が共存する。
  const bullet = line(page, '手順:');
  await expect(bullet.locator('.cm-list-bullet')).toHaveText('•');
  await expect(bullet.locator('[data-testid="embed-image"] img')).toBeVisible();

  // 番号付き項目内。
  const ordered = line(page, '番号:');
  await expect(ordered).toContainText('1.');
  await expect(ordered.locator('[data-testid="embed-image"] img')).toBeVisible();

  // ネスト箇条書き項目内。
  const nested = line(page, 'ネスト:');
  await expect(nested.locator('[data-testid="embed-image"] img')).toBeVisible();

  // data-path はフルパス (assets/pic.png) で解決されている (basename 解決の確認)。
  await expect(para.locator('[data-testid="embed-image"]')).toHaveAttribute('data-path', REL_IMG);

  expect(unexpected).toEqual([]);
});

test('[MOCK] 標準 ![](path) と 通常 wikilink ([[メモ帳]] 解決 / [[存在しないノート]] 壊れ) の回帰', async ({ page }) => {
  const unexpected = await openJournal(page);
  await line(page, '見出し行').click();

  // 標準記法の画像は引き続き描画される。
  const std = line(page, '標準:');
  await expect(std.locator('[data-testid="embed-image"] img')).toBeVisible();

  // 通常の [[メモ帳]] は解決済みリンク (赤ではない)。
  await expect(page.locator('[data-testid="wikilink"][data-target="メモ帳.md"]')).toBeVisible();
  // 存在しないノートは従来どおり broken (赤リンク)。
  const broken = page.getByTestId('wikilink-broken');
  await expect(broken).toHaveCount(1);
  await expect(broken).toHaveAttribute('data-target', '存在しないノート.md');

  expect(unexpected).toEqual([]);
});

test('[MOCK] 埋め込み行にカーソルを置くとソース記法 ![[assets/pic.png]] が見え、外すと画像に戻る', async ({ page }) => {
  const unexpected = await openJournal(page);
  await line(page, '見出し行').click();
  await expect(page.getByTestId('embed-image')).toHaveCount(5);

  // 見出し行 → ↓ で段落行 (![[...]]) へカーソルを移す (widget は
  // contenteditable=false のためキーボードで確実に行内へ入れる)。
  await page.keyboard.press('ArrowDown'); // 空行
  await page.keyboard.press('ArrowDown'); // 段落行 (![[...]])

  const active = page.locator('[data-testid="editor"] .cm-activeLine').first();
  await expect(active).toContainText(`![[${REL_IMG}]]`); // ソース記法が見える
  // その行の画像 widget は消える → 残り 4 枚。
  await expect(page.getByTestId('embed-image')).toHaveCount(4);

  // 見出し行へ戻すと再び 5 枚に戻る。
  await line(page, '見出し行').click();
  await expect(page.getByTestId('embed-image')).toHaveCount(5);

  expect(unexpected).toEqual([]);
});

test('[MOCK][mobile] モバイル幅でもインライン ![[...]] 画像が親幅を超えず横スクロールしない', async ({ page }) => {
  const unexpected = await openJournal(page, { width: 375, height: 700 });
  await line(page, '見出し行').click();
  await expect(page.getByTestId('embed-image')).toHaveCount(5);

  const overflow = await line(page, '手順:').evaluate((el) => {
    const lineRect = el.getBoundingClientRect();
    const wrap = el.querySelector('[data-testid="embed-image"]');
    if (wrap === null) return { hasImage: false, overflowRight: 0 };
    const wr = wrap.getBoundingClientRect();
    return { hasImage: true, overflowRight: Math.round(wr.right - lineRect.right) };
  });
  expect(overflow.hasImage).toBe(true);
  expect(overflow.overflowRight).toBeLessThanOrEqual(1);

  const noHScroll = await page
    .locator('[data-testid="editor"] .cm-scroller')
    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(noHScroll).toBe(true);

  expect(unexpected).toEqual([]);
});
