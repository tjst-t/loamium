/**
 * Story S6fbf45-2「バックリンクパネル」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 */
import { test, expect } from '@playwright/test';
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

test('[AC-S6fbf45-2-1] ノートを開くと参照元 + コンテキスト行が表示され、クリックで参照元に移動できる。保存でも更新される', async ({ page }) => {
  // 参照される側 + 参照元 2 ノート (heading / alias 形式を含む) をシード
  await putNote('bl-target.md', '# バックリンク対象\n\n## 設計\n本文。\n');
  await putNote(
    'bl-source-1.md',
    '週明けに [[bl-target]] を見直す。\n',
  );
  await putNote(
    'refs/bl-source-2.md',
    '- 詳細は [[bl-target#設計|設計セクション]] を参照\n',
  );

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="bl-target.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('バックリンク対象');

  // 参照元 + コンテキスト行 + 件数
  await expect(page.getByTestId('backlink-count')).toHaveText('2');
  const item1 = page.locator('[data-testid="backlink-item"][data-source="bl-source-1.md"]');
  await expect(item1).toBeVisible();
  await expect(item1).toContainText('bl-source-1');
  await expect(item1).toContainText('週明けに [[bl-target]] を見直す。');
  const item2 = page.locator('[data-testid="backlink-item"][data-source="refs/bl-source-2.md"]');
  await expect(item2).toBeVisible();
  await expect(item2).toContainText('[[bl-target#設計|設計セクション]] を参照');

  // クリックで参照元ノートへ移動し、パネルはそのノートのバックリンクに切り替わる
  await item2.click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('bl-source-2');
  await expect(page.getByTestId('editor')).toContainText('設計セクション');
  await expect(page.getByTestId('backlink-empty')).toBeVisible();
  await expect(page.getByTestId('backlink-count')).toHaveText('0');

  // 保存でも更新される: 開いているノートへの参照が外部 (エージェント等) で増えたあと、
  // 自分の保存をトリガーにパネルへ反映される
  await page.locator('[data-testid="tree-item"][data-path="bl-target.md"]').click();
  await expect(page.getByTestId('backlink-count')).toHaveText('2');
  await putNote('bl-source-3.md', '新しい参照 [[bl-target]] を追加。\n');
  await page.locator('[data-testid="editor"] .cm-line', { hasText: '本文。' }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('追記。');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('backlink-count')).toHaveText('3');
  await expect(
    page.locator('[data-testid="backlink-item"][data-source="bl-source-3.md"]'),
  ).toBeVisible();
});
