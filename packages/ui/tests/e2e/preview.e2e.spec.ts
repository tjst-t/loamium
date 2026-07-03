/**
 * Story S9ab6c3-2「ライブプレビューと 3 レジストリ」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * mermaid / KaTeX / Shiki はバンドル同梱 (CDN なし) の実レンダラーが動く。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const NOTE_PATH = 'preview-e2e.md';
const NOTE_CONTENT = [
  '# プレビュー見出し',
  '',
  'これは **太字** と *斜体* と `inline code` を含む段落。',
  '',
  '[[Hydra 設計メモ]] へのリンクと [[Hydra 設計メモ|エイリアス]] 表示。',
  '',
  '数式 $E=mc^2$ をインラインで。',
  '',
  '$$',
  '\\int_0^1 x^2 dx',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  '  A[開始] --> B[終了]',
  '```',
  '',
  '```bash',
  'echo "hello loamium"',
  '```',
  '',
  'おしまいの段落。',
  '',
].join('\n');

async function openPreviewNote(page: Page): Promise<void> {
  const { uiUrl, apiUrl } = state();
  const res = await fetch(`${apiUrl}/api/notes/${encodeURIComponent(NOTE_PATH)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: NOTE_CONTENT }),
  });
  expect(res.ok).toBe(true);
  await page.goto(uiUrl);
  await page.locator(`[data-testid="tree-item"][data-path="${NOTE_PATH}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('プレビュー見出し');
  // カーソルを装飾に関係ない最終段落に置いておく
  await editorLine(page, 'おしまいの段落。').click();
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

test('[AC-S9ab6c3-2-1] 見出し・太字/斜体・インラインコード・[[リンク]] がカーソル行以外で装飾され、カーソル行はソース表示', async ({ page }) => {
  await openPreviewNote(page);

  // --- 見出し: # マークが隠れる ---
  const heading = editorLine(page, 'プレビュー見出し');
  await expect(heading).not.toContainText('#');

  // --- 太字/斜体/インラインコード: マークが隠れる ---
  const para = editorLine(page, '太字');
  await expect(para).toContainText('太字');
  await expect(para).toContainText('inline code');
  await expect(para).not.toContainText('**');
  await expect(para).not.toContainText('`');

  // --- [[リンク]]: wikilink ピルとして装飾 (エイリアスは表示名だけ変わる) ---
  // data-target は S6fbf45-1 で解決済み vault パスになった (S9ab6c3 decisions I8 の予定どおり)
  const link = page.locator('[data-testid="wikilink"][data-target="projects/Hydra 設計メモ.md"]');
  await expect(link).toHaveCount(2);
  await expect(link.first()).toHaveText('Hydra 設計メモ');
  await expect(link.nth(1)).toHaveText('エイリアス');
  const linkLine = editorLine(page, 'へのリンク');
  await expect(linkLine).not.toContainText('[[');

  // --- カーソルを置いた行だけソースが見える ---
  await para.click();
  await expect(editorLine(page, '太字')).toContainText('**太字**');
  await expect(editorLine(page, '太字')).toContainText('`inline code`');
  // 他の行 (見出し・リンク) は装飾されたまま
  await expect(editorLine(page, 'プレビュー見出し')).not.toContainText('#');
  await expect(page.locator('[data-testid="wikilink"]').first()).toBeVisible();

  // 見出し行にカーソル → # ソースが見える
  await editorLine(page, 'プレビュー見出し').click();
  await expect(editorLine(page, 'プレビュー見出し')).toContainText('# プレビュー見出し');
  // 太字の行はカーソルが外れたので再び装飾に戻る
  await expect(editorLine(page, '太字')).not.toContainText('**');

  // リンク行にカーソル → [[...]] ソースが見える
  await editorLine(page, 'へのリンク').click();
  await expect(editorLine(page, 'へのリンク')).toContainText('[[Hydra 設計メモ]]');

  // 装飾は表示層のみ — ファイルはピュア Markdown のまま不変
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await readFile(path.join(state().vault, NOTE_PATH), 'utf8')).toBe(NOTE_CONTENT);
});

test('[AC-S9ab6c3-2-2] mermaid フェンスが図、$…$/$$…$$ が KaTeX、コードフェンスが Shiki で描画される (3 レジストリ経由)', async ({ page }) => {
  await openPreviewNote(page);

  // --- mermaid: fence レジストリ (replace) — svg 図として描画 ---
  const mermaidWidget = page.locator('[data-testid="fence-widget"][data-lang="mermaid"]');
  await expect(mermaidWidget).toBeVisible();
  await expect(mermaidWidget.locator('svg')).toBeVisible({ timeout: 20_000 });
  await expect(mermaidWidget.locator('svg')).toContainText('開始');
  // 生の ```mermaid ソースは隠れている
  await expect(editorLine(page, '```mermaid')).toHaveCount(0);

  // --- KaTeX: inline レジストリ ($…$) と block レジストリ ($$…$$) ---
  const mathInline = page.getByTestId('math-inline');
  await expect(mathInline).toBeVisible();
  await expect(mathInline.locator('.katex').first()).toBeVisible();
  await expect(editorLine(page, '数式')).not.toContainText('$');

  const mathBlock = page.getByTestId('math-block');
  await expect(mathBlock).toBeVisible();
  await expect(mathBlock.locator('.katex').first()).toBeVisible();

  // --- Shiki: コードフェンスがハイライト付きコードとして描画 ---
  const bashWidget = page.locator('[data-testid="fence-widget"][data-lang="bash"]');
  await expect(bashWidget).toBeVisible();
  await expect(bashWidget.locator('pre.shiki')).toBeVisible({ timeout: 20_000 });
  await expect(bashWidget).toContainText('echo "hello loamium"');
  await expect(bashWidget).toContainText('shiki: github-light');

  // --- fence-widget クリックでソース編集に戻れる ---
  await mermaidWidget.click();
  await expect(editorLine(page, '```mermaid')).toBeVisible();
  await expect(editorLine(page, 'graph TD')).toBeVisible();
  // カーソルを外すと再び図に戻る
  await editorLine(page, 'おしまいの段落。').click();
  await expect(page.locator('[data-testid="fence-widget"][data-lang="mermaid"]')).toBeVisible();

  // 描画はすべて表示層のみ — ファイルは不変
  expect(await readFile(path.join(state().vault, NOTE_PATH), 'utf8')).toBe(NOTE_CONTENT);
});
