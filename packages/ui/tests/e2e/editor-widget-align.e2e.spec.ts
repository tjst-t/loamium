/**
 * ブロックウィジェット(テーブル/コードフェンス)の左端が本文行(cm-line)と一致することの
 * 回帰テスト。
 *
 * 背景: 以前は `.cm-line` にだけ横 padding(6px)が付き、ブロックウィジェットは
 * `.cm-content` 直下でその inset を持たなかったため、テーブル/コードが本文より左右に
 * 6px ずつ広がって「余白がズレる」不具合があった。横 inset を `.cm-content` 側へ集約して
 * 解消した。ここでは本文行とテーブル/コードの左端 x が一致することを検証する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const encoded = rel.split('/').map((s) => encodeURIComponent(s)).join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

/** 要素の左端 x(border-box)。ブロックウィジェットの見た目の左端に相当。 */
async function boxLeft(page: Page, locator: string): Promise<number> {
  const box = await page.locator(locator).first().boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
}

/**
 * 本文行の「テキストの見える左端」。cm-line の box 左端 + 自身の padding-left。
 * (cm-line の box 自体は常に content-box 左に来るため、内側 padding を足さないと
 * 見た目のズレを検出できない。)
 */
async function textLeft(page: Page, locator: string): Promise<number> {
  return page.locator(locator).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const pl = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    return r.x + pl;
  });
}

test('ブロックウィジェット(テーブル/コードフェンス)の左端が本文行とそろう', async ({ page }) => {
  await putNote(
    'align/ウィジェット整列.md',
    [
      'これは本文の段落です。読み取り列の左端の基準になります。',
      '',
      '| 商品 | 個数 |',
      '| --- | --- |',
      '| りんご | 12 |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );

  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.locator('[data-testid="tree-item"][data-path="align/ウィジェット整列.md"]').click();

  // カーソルをアンカー行に置く → テーブル/コードはウィジェット描画になる
  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行。' }).first().click();

  const tableWrap = page.locator('[data-testid="table-widget"]');
  const fence = page.locator('.fence-widget');
  await expect(tableWrap).toBeVisible();
  await expect(fence).toBeVisible();

  const paraX = await textLeft(page, '[data-testid="editor"] .cm-line:has-text("これは本文の段落です")');
  const tableX = await boxLeft(page, '[data-testid="table-widget"]');
  const fenceX = await boxLeft(page, '.fence-widget');

  // 本文テキストの見える左端と、テーブル/コードの左端が一致する(サブピクセル誤差のみ許容)。
  expect(Math.abs(tableX - paraX)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(fenceX - paraX)).toBeLessThanOrEqual(1.5);
});
