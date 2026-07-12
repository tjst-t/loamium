/**
 * Story Sbd061c-1「グローバル検索パレット」E2E 受け入れテスト。
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

/** 検索対象のシード (ノート名一致用 2 + 全文ヒット用 1)。 */
async function seedSearchNotes(): Promise<void> {
  await putNote('search-docs/監査ログ設計.md', '# 監査ログ設計\n\n設計メモ本文。\n');
  await putNote('search-docs/監査チェックリスト.md', '# チェックリスト\n\n点検項目。\n');
  await putNote(
    'search-docs/実装方針.md',
    '# 実装方針\n\n## 監査\n書き込み API は必ず監査ログへ追記する。\nread-only モードでは書き込みを拒否する。\n',
  );
}

async function openApp(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await expect(page.locator('.breadcrumb .current')).not.toHaveText('ノートが開かれていません');
  await expect(page.getByTestId('editor')).toBeVisible();
}

test('[AC-Sbd061c-1-1] Cmd/Ctrl+K とサイドバーの検索ボタンでパレットが開き、Esc・外側クリックで閉じる', async ({ page }) => {
  await openApp(page);

  // Ctrl+K で開く — 入力欄にフォーカス
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();

  // Esc で閉じる
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  // サイドバーの検索ボタンで開く
  await page.getByTestId('sidebar-search').click();
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();

  // 外側 (backdrop) クリックで閉じない。パレット内要素 (search-input) をクリックしても閉じない
  await page.getByTestId('search-input').click();
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-backdrop').click({ position: { x: 10, y: 10 } });
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

test('[AC-Sbd061c-1-2] 入力に応じてノート名一致と全文ヒット (スニペット・行番号付き) がインクリメンタルに表示される', async ({ page }) => {
  await seedSearchNotes();
  await openApp(page);

  await page.keyboard.press('Control+k');
  const input = page.getByTestId('search-input');
  await input.pressSequentially('監査');

  // ノート名一致セクション: タイトルに「監査」を含む 2 ノート (mark 強調付き)
  await expect(page.getByTestId('palette-section-notes')).toBeVisible();
  const noteHit = page.locator(
    '[data-testid="search-result-note"][data-path="search-docs/監査ログ設計.md"]',
  );
  await expect(noteHit).toBeVisible();
  await expect(noteHit.locator('mark')).toHaveText('監査');
  await expect(noteHit).toContainText('search-docs/監査ログ設計.md');
  await expect(
    page.locator('[data-testid="search-result-note"][data-path="search-docs/監査チェックリスト.md"]'),
  ).toBeVisible();
  await expect(page.getByTestId('search-result-note')).toHaveCount(2);
  // 全文セクションも実サーバーの /api/search から出る
  await expect(page.getByTestId('palette-section-fulltext')).toBeVisible();

  // インクリメンタル: 続けて「ログ」を打つとノート名一致が 1 件に絞られ、
  // 全文ヒットは該当行のスニペット + 行番号付きで表示される (Enter 不要)
  await input.pressSequentially('ログ');
  await expect(page.getByTestId('search-result-note')).toHaveCount(1);
  await expect(noteHit).toBeVisible();
  const ftHit = page.locator(
    '[data-testid="search-result-fulltext"][data-path="search-docs/実装方針.md"]',
  );
  await expect(ftHit).toBeVisible();
  await expect(ftHit).toHaveAttribute('data-line', '4');
  await expect(ftHit).toContainText('書き込み API は必ず監査ログへ追記する。');
  await expect(ftHit).toContainText('L4');
  await expect(ftHit.locator('mark')).toHaveText('監査ログ');
});

test('[AC-Sbd061c-1-3] 候補の Enter・クリックでノートが開き、全文ヒットは該当行にカーソルが移動する', async ({ page }) => {
  await seedSearchNotes();
  await openApp(page);

  // -- Enter でノート名一致を開く (↑↓ で選択が動くことも確認) --
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').pressSequentially('監査ログ設計');
  const noteHit = page.locator(
    '[data-testid="search-result-note"][data-path="search-docs/監査ログ設計.md"]',
  );
  await expect(noteHit).toHaveAttribute('aria-selected', 'true'); // 先頭候補が既定選択
  // 全文ヒットの到着を待ってから ↑↓ を検証する (候補 1 件だと移動先がない)
  await expect(page.getByTestId('palette-section-fulltext')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(noteHit).not.toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-result-fulltext').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await expect(noteHit).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.locator('.breadcrumb .current')).toHaveText('監査ログ設計');
  await expect(page.getByTestId('editor')).toContainText('設計メモ本文。');

  // -- クリックで全文ヒットを開く → 該当行 (L4) にカーソルが移動する --
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').pressSequentially('監査ログへ追記');
  const ftHit = page.locator(
    '[data-testid="search-result-fulltext"][data-path="search-docs/実装方針.md"][data-line="4"]',
  );
  await expect(ftHit).toBeVisible();
  await ftHit.click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.locator('.breadcrumb .current')).toHaveText('実装方針');
  await expect(page.locator('.cm-activeLine')).toHaveText('書き込み API は必ず監査ログへ追記する。');

  // -- 開いているノート内の別の行へも Enter で移動できる --
  await page.keyboard.press('Control+k');
  await page.getByTestId('search-input').pressSequentially('read-only モード');
  const ftHit2 = page.locator(
    '[data-testid="search-result-fulltext"][data-path="search-docs/実装方針.md"][data-line="5"]',
  );
  await expect(ftHit2).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.locator('.cm-activeLine')).toHaveText('read-only モードでは書き込みを拒否する。');
});
