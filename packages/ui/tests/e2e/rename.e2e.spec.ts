/**
 * Story S6fbf45-3「リネーム時のリンク追従」E2E 受け入れテスト (UI 経由)。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * API 単体の網羅 (全リンク形式・安全性) は tests/acceptance/rename.spec.ts。
 */
import { test, expect } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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

const SRC_CONTENT = [
  '進捗は [[rn-target]] と [[rn-target#メモ|ターゲット]] を参照。',
  '',
  '```',
  'フェンス内 [[rn-target]] は不変。',
  '```',
  '',
  'アンカー行。',
  '',
].join('\n');

test('[AC-S6fbf45-3-2] ツリーからのリネームでリンク追従が動き、監査ログに記録される', async ({ page }) => {
  await putNote('rn-target.md', '# ターゲット\n\n## メモ\n本文。\n');
  await putNote('rn-src.md', SRC_CONTENT);

  // 参照元ノートを開いた状態でツリーからターゲットをリネームする
  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="rn-src.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('アンカー行');

  await page.locator('[data-testid="tree-item"][data-path="rn-target.md"]').click({ button: 'right' });
  await page.getByTestId('context-rename').click();
  await expect(page.getByTestId('rename-dialog')).toBeVisible();

  // リンク更新の説明 (1 ノートにある 2 件が対象)
  const note = page.getByTestId('rename-link-note');
  await expect(note).toContainText('1 ノートにある');
  await expect(note).toContainText('[[リンク]] 2 件');

  await page.getByTestId('rename-input').fill('rn-renamed');
  await page.getByTestId('rename-confirm').click();

  // ツリーが新名になり、旧名は消える
  await expect(page.locator('[data-testid="tree-item"][data-path="rn-renamed.md"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-item"][data-path="rn-target.md"]')).toHaveCount(0);

  // 開いていた参照元ノートのバッファも書き換え後の内容に追従する
  await expect(page.getByTestId('editor')).toContainText('[[rn-renamed]]');

  // ディスク上の参照元: 通常/heading+alias 形式は追従、フェンス内は不変
  const src = await readFile(path.join(state().vault, 'rn-src.md'), 'utf8');
  expect(src).toBe(
    [
      '進捗は [[rn-renamed]] と [[rn-renamed#メモ|ターゲット]] を参照。',
      '',
      '```',
      'フェンス内 [[rn-target]] は不変。',
      '```',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );

  // ファイル本体も移動している
  expect((await stat(path.join(state().vault, 'rn-renamed.md'))).isFile()).toBe(true);
  await expect(async () => {
    await stat(path.join(state().vault, 'rn-target.md'));
  }).rejects.toThrow();

  // 監査ログに note.rename が記録されている (AC-S6fbf45-3-2)
  const audit = await readFile(path.join(state().vault, '.loamium/audit.log'), 'utf8');
  const entries = audit
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { op: string; path: string; result: string });
  expect(
    entries.some((e) => e.op === 'note.rename' && e.path === 'rn-target.md' && e.result === 'ok'),
  ).toBe(true);

  // リネーム後、開いているノートの [[rn-renamed]] クリックで移動できる (リンクは生きている)
  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).first().click();
  await page.locator('[data-testid="wikilink"][data-target="rn-renamed.md"]').first().click();
  await expect(page.locator('.breadcrumb .current')).toHaveText('rn-renamed');
});
