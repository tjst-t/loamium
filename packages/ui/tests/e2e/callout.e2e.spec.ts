/**
 * Story S9e5ca4-3「callout」E2E 受け入れテスト。
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

test('[AC-S9e5ca4-3-1] 5 タイプの callout が色付きボックスで描画され、未知タイプは note にフォールバック、[!note]- は閉状態で開閉できる', async ({ page }) => {
  await putNote(
    'callout/移行手順.md',
    [
      '# 移行手順',
      '',
      '> [!note]',
      '> 手順は上から順に実施する。',
      '',
      '> [!info] 参考情報',
      '> 旧構成は凍結済みノートを参照。',
      '',
      '> [!tip]',
      '> スナップショットなら停止なしで取得できる。',
      '',
      '> [!warning] 切替前の確認',
      '> DNS TTL を前日までに短縮しておくこと。',
      '',
      '> [!danger]',
      '> 旧ディスクの初期化は検証が終わるまで行わない。',
      '',
      '> [!hoge] 未知タイプ',
      '> note スタイルで描画されること。',
      '',
      '> [!note]- リハーサルログ',
      '> vzdump 実測 52 分、restore 実測 38 分。',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
  await openApp(page);
  await page.locator('[data-testid="tree-item"][data-path="callout/移行手順.md"]').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('移行手順');
  await editorLine(page, 'アンカー行').click();

  // ---- 5 タイプ + タイトル (省略時は既定、指定時はカスタム) ----
  const note = page.locator('[data-testid="callout"][data-type="note"]', {
    hasText: '手順は上から順に実施する。',
  });
  await expect(note).toBeVisible();
  await expect(note.locator('.callout-title')).toContainText('メモ');
  await expect(note).toContainText('手順は上から順に実施する。');

  const info = page.locator('[data-testid="callout"][data-type="info"]');
  await expect(info).toBeVisible();
  await expect(info.locator('.callout-title')).toContainText('参考情報');

  const tip = page.locator('[data-testid="callout"][data-type="tip"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('スナップショットなら停止なしで取得できる。');

  const warning = page.locator('[data-testid="callout"][data-type="warning"]');
  await expect(warning).toBeVisible();
  await expect(warning.locator('.callout-title')).toContainText('切替前の確認');

  const danger = page.locator('[data-testid="callout"][data-type="danger"]');
  await expect(danger).toBeVisible();
  await expect(danger).toContainText('旧ディスクの初期化は検証が終わるまで行わない。');

  // タイプごとに色 (背景) が変わる: note と danger の computed background が異なる
  const noteBg = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
  const dangerBg = await danger.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(noteBg).not.toBe(dangerBg);

  // ---- 未知タイプは note スタイルにフォールバック ----
  const unknown = page.locator('[data-testid="callout"][data-type="note"]', {
    hasText: '未知タイプ',
  });
  await expect(unknown).toBeVisible();
  await expect(unknown).toContainText('note スタイルで描画されること。');
  // [!hoge] のままの data-type は存在しない
  await expect(page.locator('[data-testid="callout"][data-type="hoge"]')).toHaveCount(0);

  // ---- [!note]- は閉じた状態で描画され、タイトルクリックで開閉 ----
  const folded = page.locator('[data-testid="callout"][data-folded]');
  await expect(folded).toHaveAttribute('data-folded', 'true');
  await expect(folded.locator('.callout-body')).toBeHidden();
  await expect(folded.getByTestId('callout-fold')).toHaveAttribute('aria-expanded', 'false');

  await folded.getByTestId('callout-fold').click();
  await expect(folded).toHaveAttribute('data-folded', 'false');
  await expect(folded.locator('.callout-body')).toBeVisible();
  await expect(folded).toContainText('vzdump 実測 52 分');

  await folded.getByTestId('callout-fold').click();
  await expect(folded).toHaveAttribute('data-folded', 'true');
  await expect(folded.locator('.callout-body')).toBeHidden();

  // ---- カーソルをブロックへ置くとソース記法が見える ----
  await warning.click();
  await expect(editorLine(page, '> [!warning] 切替前の確認')).toBeVisible();
  await editorLine(page, 'アンカー行').click();
  await expect(warning).toBeVisible();
});
