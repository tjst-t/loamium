/**
 * 幅広テーブルが読み取り列(820px)を超えて .cm-content を広げ、中央寄せ余白を消さないことの検証。
 * ワークスペースを 820px より広くした状態で、幅広テーブルを描画・スクロールして
 * .cm-content の幅が 820px 付近に留まる(余白が保たれる)ことを確認する。
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

async function contentWidth(page: Page): Promise<number> {
  const box = await page.locator('[data-testid="editor"] .cm-content').first().boundingBox();
  expect(box).not.toBeNull();
  return box!.width;
}

test('幅広テーブルでも .cm-content は読み取り列(~820px)を超えず余白が保たれる', async ({ page }) => {
  const longCell = 'とても長いセル内容。'.repeat(20);
  const spacer = Array.from({ length: 30 }, (_, i) => `段落 ${String(i)} です。ここは読み取り列の基準になる本文行。`).join('\n\n');
  await putNote(
    'wide/幅広テーブル.md',
    [
      '# 見出し',
      '',
      spacer,
      '',
      `| コンポーネント | 変更内容 |`,
      `| --- | --- |`,
      `| **A** | ${longCell} |`,
      `| **B** | ${longCell} |`,
      '',
      'アンカー段落。',
      '',
    ].join('\n'),
  );

  // ワークスペースを 820px 弱にする(「絶妙な幅」— この帯域で従来は幅広テーブルが
  // 描画されると読み取り列が available→820 へ伸び、余白が消えていた)。
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(state().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.locator('[data-testid="tree-item"][data-path="wide/幅広テーブル.md"]').click();

  // 上部(テーブル未描画)での読み取り列幅
  const topWidth = await contentWidth(page);
  expect(topWidth).toBeLessThanOrEqual(824); // 820 + 誤差

  // 幅広テーブルが描画されるまでホイールでスクロール
  await page.locator('[data-testid="editor"]').hover();
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 500);
    if (await page.locator('[data-testid="table-widget"]').count() > 0) break;
    await page.waitForTimeout(150);
  }
  await expect(page.locator('[data-testid="table-widget"]')).toBeVisible();
  await page.waitForTimeout(300);

  const afterWidth = await contentWidth(page);
  // テーブルが .cm-content を 820px より大きく広げていない(= 余白が消えない)
  expect(afterWidth).toBeLessThanOrEqual(824);
  // スクロール(テーブル描画)前後で読み取り列幅が変化しない(= 余白がジャンプしない)
  expect(Math.abs(afterWidth - topWidth)).toBeLessThanOrEqual(2);
});
