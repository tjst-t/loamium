/**
 * Story Sa704c3-1「ファイルツリーとエディタで編集・保存」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 *
 * Sf1a90a のシェル刷新後: サイドバーは mtime 順の直近ファイル (フラット) 一覧。
 * フォルダツリー閲覧はファイル一覧ページ (Seac77a) へ移設したため、本テストは
 * フォルダ展開ではなく「直近一覧に現れる/クリックで開く/作成・リネーム・削除」を検証する。
 * 検証対象ノートはテスト内で API 作成し、直近一覧の先頭に来る前提で操作する。
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`putNote ${rel} failed: ${String(res.status)}`);
}

test('[AC-Sa704c3-1-1] 直近ファイル一覧にノートが現れ、クリックで CodeMirror エディタに開く', async ({
  page,
}) => {
  const NP = 'editor-open-e2e.md';
  await putNote(NP, '# 開くテスト\n\nREST API は Sd63ad1 で実装済み\n');

  await page.goto(state().uiUrl);

  // 直近作成したノートはサイドバーの直近一覧に出る (tree-item + data-path)
  const item = page.locator(`[data-testid="tree-item"][data-path="${NP}"]`);
  await expect(item).toBeVisible();

  // クリックで CodeMirror エディタに本文が開く
  await item.click();
  await expect(page.getByTestId('editor')).toContainText('REST API は Sd63ad1 で実装済み');
  await expect(item).toHaveClass(/active/);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  // 開いたノートは URL (ルート) に反映される (Sf1a90a-1)
  await expect(page).toHaveURL(/\/n\/editor-open-e2e$/);
});

test('[AC-Sa704c3-1-2] Cmd/Ctrl+S と自動保存で編集が保存され、再読み込み後も保持される (ファイルはピュア Markdown のまま)', async ({
  page,
}) => {
  const NP = 'editor-save-e2e.md';
  await putNote(NP, '# 保存テスト\n\nlezer-markdown\n');
  const stamp = `E2E手動保存-${String(Date.now())}`;
  await page.goto(state().uiUrl);

  await page.locator(`[data-testid="tree-item"][data-path="${NP}"]`).click();
  await expect(page.getByTestId('editor')).toContainText('lezer-markdown');

  // --- Ctrl+S 手動保存 ---
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n${stamp}`);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 再読み込み後も内容が保持される (URL 復帰で同じノートに戻る — Sf1a90a-1)
  await page.reload();
  await expect(page.getByTestId('editor')).toContainText(stamp);

  // ファイルはピュア Markdown のまま
  const fileContent = await readFile(path.join(state().vault, NP), 'utf8');
  expect(fileContent).toContain(stamp);
  expect(fileContent.startsWith('# 保存テスト')).toBe(true);
  expect(fileContent).not.toMatch(/\^[a-zA-Z0-9]{4,}/);
  expect(fileContent).not.toContain('id::');
  expect(fileContent).not.toContain('\r');

  // --- 自動保存 (デバウンス) ---
  const autoStamp = `E2E自動保存-${String(Date.now())}`;
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n${autoStamp}`);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await expect(page.getByTestId('editor')).toContainText(autoStamp);
});

test('[AC-Sa704c3-1-3] 直近一覧から新規ノート作成・リネーム・削除ができる', async ({ page }) => {
  await page.goto(state().uiUrl);

  // --- 新規作成 (サイドバーの + ボタン ▸ 空のノート — S89a350-3 でメニュー化) ---
  await page.getByTestId('sidebar-new-note').click();
  await page.getByTestId('new-note-menu-blank').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
  await page.getByTestId('new-note-input').fill('E2E 新規ノート');
  await page.getByTestId('new-note-confirm').click();

  const created = page.locator('[data-testid="tree-item"][data-path="E2E 新規ノート.md"]');
  await expect(created).toBeVisible();
  await expect(created).toHaveClass(/active/);

  await page.getByTestId('editor').click();
  await page.keyboard.type('新規ノートの本文です。');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // --- リネーム (右クリックメニュー → ダイアログ) ---
  await created.click({ button: 'right' });
  await expect(page.getByTestId('tree-context-menu')).toBeVisible();
  await page.getByTestId('context-rename').click();
  await expect(page.getByTestId('rename-dialog')).toBeVisible();
  await page.getByTestId('rename-input').fill('E2E リネーム済み');
  await page.getByTestId('rename-confirm').click();

  const renamed = page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]');
  await expect(renamed).toBeVisible();
  await expect(page.locator('[data-testid="tree-item"][data-path="E2E 新規ノート.md"]')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('新規ノートの本文です。');

  // リネームは再読み込み後も persist している
  await page.goto(state().uiUrl);
  await expect(renamed).toBeVisible();

  // --- 削除 (右クリックメニュー → 確認ダイアログ) ---
  await renamed.click();
  await expect(page.getByTestId('editor')).toContainText('新規ノートの本文です。');
  await renamed.click({ button: 'right' });
  await page.getByTestId('context-delete').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await page.getByTestId('delete-confirm').click();

  await expect(page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]')).toHaveCount(0);
  await expect(page.getByTestId('editor-empty-state')).toBeVisible();

  await page.goto(state().uiUrl);
  await expect(page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]')).toHaveCount(0);
});

test('[AC-Sa704c3-1-3] コンテキストメニューの「同じフォルダに新規ノート」でフォルダ内に作成できる', async ({
  page,
}) => {
  const parent = 'proj-e2e/親ノート.md';
  await putNote(parent, '# 親ノート\n');
  await page.goto(state().uiUrl);

  // ノート行の右クリック → 同じフォルダ (proj-e2e) 内に新規ノート
  const parentItem = page.locator(`[data-testid="tree-item"][data-path="${parent}"]`);
  await expect(parentItem).toBeVisible();
  await parentItem.click({ button: 'right' });
  await expect(page.getByTestId('tree-context-menu')).toBeVisible();
  await page.getByTestId('context-new-note').click();
  await page.getByTestId('new-note-input').fill('子ノート');
  await page.getByTestId('new-note-confirm').click();
  const child = page.locator('[data-testid="tree-item"][data-path="proj-e2e/子ノート.md"]');
  await expect(child).toBeVisible();

  // 再読み込み後も永続化されている
  await page.goto(state().uiUrl);
  await expect(page.locator('[data-testid="tree-item"][data-path="proj-e2e/子ノート.md"]')).toBeVisible();

  // 後片付け
  for (const p of ['proj-e2e/子ノート.md', parent]) {
    await page.locator(`[data-testid="tree-item"][data-path="${p}"]`).click({ button: 'right' });
    await page.getByTestId('context-delete').click();
    await page.getByTestId('delete-confirm').click();
    await expect(page.locator(`[data-testid="tree-item"][data-path="${p}"]`)).toHaveCount(0);
  }
});

test('[AC-Sa704c3-1-2] 別プロセスの変更と競合したら警告ダイアログを出す (mtime 楽観的検出)', async ({
  page,
}) => {
  const { uiUrl, apiUrl } = state();

  await fetch(`${apiUrl}/api/notes/conflict-e2e.md`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'server v1\n' }),
  });

  await page.goto(uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="conflict-e2e.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('server v1');

  // --- 再読込パス: 外部プロセスが同じノートを書き換える ---
  await new Promise((r) => setTimeout(r, 20));
  await fetch(`${apiUrl}/api/notes/conflict-e2e.md`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'server v2 (外部編集)\n' }),
  });

  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('ローカル編集');
  await page.keyboard.press('Control+s');

  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  await page.getByTestId('conflict-reload').click();
  await expect(page.getByTestId('editor')).toContainText('server v2 (外部編集)');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // --- 上書きパス ---
  await new Promise((r) => setTimeout(r, 20));
  await fetch(`${apiUrl}/api/notes/conflict-e2e.md`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'server v3 (外部編集 2 回目)\n' }),
  });

  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('上書きしたい編集');
  await page.keyboard.press('Control+s');

  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  await page.getByTestId('conflict-overwrite').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.goto(uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="conflict-e2e.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('上書きしたい編集');
  await expect(page.getByTestId('editor')).not.toContainText('server v3');

  // 後片付け
  await page.locator('[data-testid="tree-item"][data-path="conflict-e2e.md"]').click({ button: 'right' });
  await page.getByTestId('context-delete').click();
  await page.getByTestId('delete-confirm').click();
  await expect(page.locator('[data-testid="tree-item"][data-path="conflict-e2e.md"]')).toHaveCount(0);
});
