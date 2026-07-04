/**
 * Story S9e5ca4-4「==highlight==」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 */
import { test, expect, type Page } from '@playwright/test';
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

async function openApp(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await expect(page.locator('.breadcrumb .current')).not.toHaveText('ノートが開かれていません');
  await expect(page.getByTestId('editor')).toBeVisible();
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

test('[AC-S9e5ca4-4-1] ==text== がカーソル行以外でハイライトされ、カーソル行はソース表示、コードフェンス・インラインコード内は装飾されない', async ({ page }) => {
  await putNote(
    'highlight/チェックリスト.md',
    [
      '# チェックリスト',
      '',
      'DNS の切替は ==22:00 以降== に行うこと。',
      '',
      '```',
      'echo "==フェンス内は装飾しない=="',
      '```',
      '',
      'インラインコード `==コード内も装飾しない==` はそのまま。',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await openApp(page);
  await page.locator('[data-testid="tree-item"][data-path="highlight/チェックリスト.md"]').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('チェックリスト');
  await editorLine(page, 'アンカー行').click();

  // 本文の ==22:00 以降== はハイライトされ、マーク記号は見えない
  const marks = page.getByTestId('highlight');
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText('22:00 以降');
  await expect(editorLine(page, 'DNS の切替は')).not.toContainText('==');
  // マーカーの背景色が付いている (mark 相当の装飾)
  const bg = await marks.first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');

  // コードフェンス内・インラインコード内はソースのまま (highlight は 1 個だけ)
  await expect(editorLine(page, 'フェンス内は装飾しない')).toContainText(
    '==フェンス内は装飾しない==',
  );
  await expect(editorLine(page, 'コード内も装飾しない')).toContainText(
    '==コード内も装飾しない==',
  );

  // カーソルを置いた行はソースが見える (装飾が外れる)
  await editorLine(page, 'DNS の切替は').click();
  await expect(page.getByTestId('highlight')).toHaveCount(0);
  await expect(editorLine(page, 'DNS の切替は')).toContainText('==22:00 以降==');

  // カーソルが離れると再びハイライトされる
  await editorLine(page, 'アンカー行').click();
  await expect(page.getByTestId('highlight')).toHaveCount(1);
});
