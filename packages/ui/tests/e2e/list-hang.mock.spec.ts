/**
 * Story S6848dc-1 mock テスト — リスト折り返しのぶら下げインデント。
 *
 * 箇条書き/番号付きリストの 1 項目が折り返すと、2 行目以降がマーカー直後の
 * テキスト開始位置にそろう (左端 0 に戻らない) ことを検証する。表示のみの
 * ライン装飾 (.cm-list-line + --hang) + CSS で実現し、ファイル内容は書き換えない。
 *
 * page.route で全 /api/* をモックする。実サーバー不要。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;

// 折り返しを確実に起こす長文。ネスト項目 (4 スペース) も含める。
const LONG = 'これは折り返しを確実に発生させるための十分に長いリスト項目のテキストです。'.repeat(3);
const NESTED_LONG = 'ネストした子項目でも折り返しがテキスト開始位置にそろうことを確認する長い文章。'.repeat(3);

const LIST_CONTENT = [
  '# 見出し行',
  '',
  `- ${LONG}`,
  `    - ${NESTED_LONG}`,
  `1. ${LONG}`,
  '',
].join('\n');

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

async function openList(page: Page): Promise<string[]> {
  // 折り返しを起こしやすいよう十分に狭いビューポート (デスクトップレイアウト維持のため 700px)。
  await page.setViewportSize({ width: 700, height: 800 });
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(LIST_CONTENT)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('折り返しを確実に');
  return unexpected;
}

/** テキストを含む .cm-line を返す (装飾表示にするため見出し行にカーソルを置く前提)。 */
function line(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

/**
 * リスト行の折り返し 2 行目の左端 x が、1 行目のテキスト開始 x と一致し、
 * かつ行ボックス左端 (0px 相当) に戻っていないことを検証する。
 * DOM の Range.getClientRects() で視覚行ごとの矩形を取得して測る。
 */
async function assertHangs(page: Page, text: string): Promise<void> {
  const el = line(page, text);
  await expect(el).toHaveClass(/cm-list-line/);

  // --hang / padding / text-indent が揃っている (表示のみ) こと。
  const box = await el.evaluate((node) => {
    const cs = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    // 行の本文テキストノードだけをまたぐ Range を作り、視覚行ごとの矩形を得る。
    // (マーカー装飾 = .cm-list-bullet 等のウィジェットは除外し、本文の折り返しだけを測る)
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects())
      // 実テキスト run のみ (ウィジェットバッファ/ゼロ幅/1文字の装飾ドットを除外)
      .filter((r) => r.width > 30 && r.height > 0);
    // y でグルーピングして「視覚行」ごとの最小 left を求める。
    const rows: { top: number; left: number }[] = [];
    for (const r of rects) {
      const found = rows.find((row) => Math.abs(row.top - r.top) < 4);
      if (found) found.left = Math.min(found.left, r.left);
      else rows.push({ top: r.top, left: r.left });
    }
    rows.sort((a, b) => a.top - b.top);
    return {
      paddingInlineStart: parseFloat(cs.paddingInlineStart),
      textIndent: parseFloat(cs.textIndent),
      lineLeft: rect.left,
      rowCount: rows.length,
      rowLefts: rows.map((r) => r.left),
    };
  });

  // 折り返しが実際に起きている (本文の視覚行が 2 行以上)。
  expect(box.rowCount).toBeGreaterThanOrEqual(2);
  // ぶら下げ: padding-inline-start は正、text-indent は同量の負 (相殺で 1 行目が元位置)。
  expect(box.paddingInlineStart).toBeGreaterThan(6); // 6px の基準パディング + --hang
  expect(box.textIndent).toBeLessThan(0);
  // padding とマイナス text-indent は同量 (--hang) で相殺する → 1 行目のマーカーは
  // 基準パディング (6px) 位置に戻る (ソースの見た目カラムを崩さない)。
  expect(Math.abs(box.paddingInlineStart + box.textIndent - 6)).toBeLessThan(1);

  // ぶら下げ位置 (= padding 原点) は行左端 + padding-inline-start。
  const hangX = box.lineLeft + box.paddingInlineStart;
  // 折り返し 2 行目以降の本文左端がぶら下げ位置にそろう (左端 0 = 行左端には戻らない)。
  for (let i = 1; i < box.rowLefts.length; i++) {
    expect(Math.abs(box.rowLefts[i] - hangX)).toBeLessThan(3);
  }
  // ぶら下げ位置は基準パディング (行左端 + 6px) より明確に右 = マーカー幅ぶん字下げされている。
  expect(hangX - (box.lineLeft + 6)).toBeGreaterThan(10);
}

test('[MOCK] 箇条書きの折り返し 2 行目がテキスト開始位置にそろう (AC-1)', async ({ page }) => {
  const unexpected = await openList(page);
  await line(page, '見出し行').click(); // リスト行を装飾表示 (非アクティブ) にする
  await assertHangs(page, LONG.slice(0, 20));
  expect(unexpected).toEqual([]);
});

test('[MOCK] ネストした項目でも折り返しがその項目のテキスト開始位置にそろう (AC-2)', async ({ page }) => {
  const unexpected = await openList(page);
  await line(page, '見出し行').click();

  // ネスト項目のぶら下げ量 (--hang) は親項目より大きい (先頭 4 スペース分深い)。
  const nested = line(page, NESTED_LONG.slice(0, 20));
  const parent = line(page, LONG.slice(0, 20));
  await expect(nested).toHaveClass(/cm-list-line/);
  const nestedHang = await nested.evaluate((n) => parseFloat(getComputedStyle(n).paddingInlineStart));
  const parentHang = await parent.evaluate((n) => parseFloat(getComputedStyle(n).paddingInlineStart));
  expect(nestedHang).toBeGreaterThan(parentHang);

  await assertHangs(page, NESTED_LONG.slice(0, 20));
  expect(unexpected).toEqual([]);
});

test('[MOCK] 番号付きリストの折り返しもぶら下げそろえされる (AC-1)', async ({ page }) => {
  const unexpected = await openList(page);
  await line(page, '見出し行').click();
  // "1. " は 3 カラム → --hang = 3ch。折り返し 2 行目がそこにそろう。
  const el = page.locator('[data-testid="editor"] .cm-line', { hasText: LONG.slice(0, 20) }).nth(1);
  await expect(el).toHaveClass(/cm-list-line/);
  const style = await el.evaluate((n) => getComputedStyle(n).getPropertyValue('--hang').trim());
  expect(style).toBe('3ch');
  expect(unexpected).toEqual([]);
});

test('[MOCK][mobile] モバイル幅でもぶら下げが保たれ本文が横スクロールしない (AC-4)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(
      json({ notes: [{ path: JOURNAL_PATH, title: DATE, tags: [], folder: 'journals' }] }),
    );
  });
  await page.route('**/api/journal', (route) => {
    void route.fulfill(json(journal(LIST_CONTENT)));
  });
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toContainText('折り返しを確実に');

  await line(page, '見出し行').click();
  await assertHangs(page, LONG.slice(0, 20));

  // 本文 (cm-content) が横スクロールしていない (scrollWidth <= clientWidth + 誤差)。
  const noHScroll = await page
    .locator('[data-testid="editor"] .cm-scroller')
    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(noHScroll).toBe(true);
  expect(unexpected).toEqual([]);
});
