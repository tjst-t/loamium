/**
 * Story S9e5ca4-1/2「![[embed]] transclusion・画像埋め込み」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

/** 1x1 の実 PNG (画像表示検証用)。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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

async function openNoteViaTree(page: Page, rel: string): Promise<void> {
  await page.locator(`[data-testid="tree-item"][data-path="${rel}"]`).click();
  const name = (rel.split('/').at(-1) ?? rel).replace(/\.md$/, '');
  await expect(page.locator('.breadcrumb .current')).toHaveText(name);
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

test('[AC-S9e5ca4-1-1] ![[note]] が読み取り専用カードとして描画され、ヘッダクリックで元ノートに移動する', async ({ page }) => {
  await putNote(
    'embed-basic/元ノート.md',
    '# 元ノート\n\n正本はこの一箇所だけに書く。\n\n- 項目その 1\n- 項目その 2\n',
  );
  await putNote(
    'embed-basic/引用元.md',
    '# 引用元\n\n前提のノートをコピーせず埋め込む:\n\n![[元ノート]]\n\nアンカー行。\n',
  );
  await openApp(page);
  await openNoteViaTree(page, 'embed-basic/引用元.md');
  await editorLine(page, 'アンカー行').click();

  // カーソル外の ![[元ノート]] 行が埋め込みカードになり、元ノートの内容が出る
  const card = page.locator('[data-testid="embed-card"][data-target="embed-basic/元ノート.md"]');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('embed-card-open')).toContainText('元ノート');
  await expect(card).toContainText('正本はこの一箇所だけに書く。');
  await expect(card).toContainText('項目その 1');

  // カードは読み取り専用ビュー: 本文クリックはソース編集へ戻るだけ (記法が見える)
  await card.locator('.embed-body').click();
  await expect(editorLine(page, '![[元ノート]]')).toBeVisible();
  await editorLine(page, 'アンカー行').click();
  await expect(card).toBeVisible();

  // ヘッダクリックで元ノートへ移動する
  await card.getByTestId('embed-card-open').click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('元ノート');
  await expect(page.getByTestId('editor')).toContainText('正本はこの一箇所だけに書く。');
});

test('[AC-S9e5ca4-1-2] ![[note#見出し]] でその見出しセクションのみが埋め込まれる', async ({ page }) => {
  await putNote(
    'embed-section/方針.md',
    [
      '# 方針',
      '',
      '## インデックス更新',
      'chokidar のイベントをデバウンスして再パースする。',
      '',
      '## 競合制御',
      'last-write-wins + mtime 検出から始める。',
      '',
    ].join('\n'),
  );
  await putNote(
    'embed-section/開発ログ.md',
    '# 開発ログ\n\n![[方針#インデックス更新]]\n\nアンカー行。\n',
  );
  await openApp(page);
  await openNoteViaTree(page, 'embed-section/開発ログ.md');
  await editorLine(page, 'アンカー行').click();

  const card = page.locator(
    '[data-testid="embed-card"][data-target="embed-section/方針.md"][data-section="インデックス更新"]',
  );
  await expect(card).toBeVisible();
  await expect(card.getByTestId('embed-card-open')).toContainText('# インデックス更新');
  // 該当セクションの内容だけが出る (他セクションは含まれない)
  await expect(card).toContainText('chokidar のイベントをデバウンスして再パースする。');
  await expect(card).not.toContainText('last-write-wins');
});

test('[AC-S9e5ca4-1-3] 循環埋め込み (A→B→A) と深さ超過は深さ制限で安全にエラーカードになる (UI はフリーズ・クラッシュしない)', async ({ page }) => {
  await putNote('embed-cycle/循環A.md', '# 循環A\n\nA の本文。\n\n![[循環B]]\n\nアンカー行。\n');
  await putNote('embed-cycle/循環B.md', '# 循環B\n\nB の本文。\n\n![[循環A]]\n');
  // 深さ超過チェーン: d1 → d2 → … → d6 (最大深さ 5 で打ち切り)
  for (let i = 1; i <= 6; i++) {
    const next = i < 6 ? `\n![[深さ${String(i + 1)}]]\n` : '\n末端。\n';
    await putNote(`embed-depth/深さ${String(i)}.md`, `# 深さ${String(i)}\n${next}`);
  }
  await openApp(page);

  // ---- 循環: A を開くと B のカードの中で A がエラーカードとして打ち切られる ----
  await openNoteViaTree(page, 'embed-cycle/循環A.md');
  await editorLine(page, 'アンカー行').click();
  const cardB = page.locator('[data-testid="embed-card"][data-target="embed-cycle/循環B.md"]');
  await expect(cardB).toBeVisible();
  await expect(cardB).toContainText('B の本文。');
  const cycleError = cardB.locator('[data-testid="embed-error"][data-target="embed-cycle/循環A.md"]');
  await expect(cycleError).toBeVisible();
  await expect(cycleError).toContainText('循環埋め込みを検出しました');
  await expect(cycleError).toContainText('循環A → 循環B → 循環A');

  // UI はフリーズしていない: 編集して保存インジケータが応答する
  await editorLine(page, 'アンカー行').click();
  await page.keyboard.type('追記');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 15_000,
  });

  // ---- 深さ超過: d1 を開くと 5 段目のカード内で d6 が打ち切られる ----
  await openNoteViaTree(page, 'embed-depth/深さ1.md');
  await editorLine(page, '# 深さ1').click();
  const depthError = page.locator(
    '[data-testid="embed-error"][data-target="embed-depth/深さ6.md"]',
  );
  await expect(depthError).toBeVisible();
  await expect(depthError).toContainText('埋め込みが深すぎます (最大深さ 5)');
  // 4 段のカード (d2〜d5) は正常に開けている
  for (let i = 2; i <= 5; i++) {
    await expect(
      page.locator(`[data-testid="embed-card"][data-target="embed-depth/深さ${String(i)}.md"]`),
    ).toBeVisible();
  }
});

test('[AC-S9e5ca4-2-2] ![[image.png]] と ![](path) がエディタ内で画像として表示される (/api/files 経由)', async ({ page }) => {
  // 画像は書き込み API の対象外 (アップロードは未実装) なので一時 vault へ直接シード
  const abs = path.join(state().vault, 'assets/pixel.png');
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, PIXEL_PNG);
  await putNote(
    'embed-image/図版.md',
    '# 図版\n\n![[assets/pixel.png]]\n\n![ラック写真](assets/pixel.png)\n\nアンカー行。\n',
  );
  await openApp(page);
  await openNoteViaTree(page, 'embed-image/図版.md');
  await editorLine(page, 'アンカー行').click();

  const images = page.locator('[data-testid="embed-image"][data-path="assets/pixel.png"]');
  await expect(images).toHaveCount(2);
  for (const img of [images.nth(0).locator('img'), images.nth(1).locator('img')]) {
    await expect(img).toBeVisible();
    // 実サーバーの GET /api/files から実際にデコードできた証拠 (1x1 PNG)
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(1);
  }
  const src = await images.nth(0).locator('img').getAttribute('src');
  expect(src).toBe('/api/files/assets/pixel.png');
});
