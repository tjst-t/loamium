/**
 * Story Sa704c3-1「ファイルツリーとエディタで編集・保存」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * ファイルシステムへの直接アクセスは「ピュア Markdown のまま」の検証と
 * 外部プロセスの書き込みシミュレーション (競合シナリオ) に限る。
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

test('[AC-Sa704c3-1-1] ファイルツリーに vault のフォルダ構造が表示され、クリックでノートが CodeMirror エディタに開く', async ({ page }) => {
  await page.goto(state().uiUrl);

  // フォルダ構造 (projects / journals) とルート直下のノートが見える
  await expect(page.locator('[data-testid="tree-folder"][data-path="projects"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-folder"][data-path="journals"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-item"][data-path="CodeMirror 6 調査.md"]')).toBeVisible();

  // クリックで CodeMirror エディタに本文が開く
  const item = page.locator('[data-testid="tree-item"][data-path="projects/Loamium 開発ログ.md"]');
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId('editor')).toContainText('REST API は Sd63ad1 で実装済み');
  await expect(item).toHaveClass(/active/);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // フォルダの開閉トグル
  await page.locator('[data-testid="tree-folder"][data-path="projects"]').click();
  await expect(item).not.toBeVisible();
  await page.locator('[data-testid="tree-folder"][data-path="projects"]').click();
  await expect(item).toBeVisible();
});

test('[AC-Sa704c3-1-2] Cmd/Ctrl+S と自動保存で編集が保存され、再読み込み後も保持される (ファイルはピュア Markdown のまま)', async ({ page }) => {
  const stamp = `E2E手動保存-${String(Date.now())}`;
  await page.goto(state().uiUrl);

  await page.locator('[data-testid="tree-item"][data-path="CodeMirror 6 調査.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('lezer-markdown');

  // --- Ctrl+S 手動保存 ---
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n${stamp}`);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // 再読み込み後も内容が保持される (UI 経由で読み戻す)
  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="CodeMirror 6 調査.md"]').click();
  await expect(page.getByTestId('editor')).toContainText(stamp);

  // ファイルはピュア Markdown のまま: ブロック ID や独自記法が混入していない
  const fileContent = await readFile(path.join(state().vault, 'CodeMirror 6 調査.md'), 'utf8');
  expect(fileContent).toContain(stamp);
  expect(fileContent.startsWith('# CodeMirror 6 調査')).toBe(true);
  expect(fileContent).not.toMatch(/\^[a-zA-Z0-9]{4,}/); // ^blockid なし
  expect(fileContent).not.toContain('id::'); // LogSeq ブロック ID なし
  expect(fileContent).not.toContain('\r'); // LF 固定

  // --- 自動保存 (デバウンス) ---
  const autoStamp = `E2E自動保存-${String(Date.now())}`;
  await page.getByTestId('editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n${autoStamp}`);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'dirty');
  // Ctrl+S を押さずにデバウンス自動保存を待つ
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.goto(state().uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="CodeMirror 6 調査.md"]').click();
  await expect(page.getByTestId('editor')).toContainText(autoStamp);
});

test('[AC-Sa704c3-1-3] ツリーから新規ノート作成・リネーム・削除ができる', async ({ page }) => {
  await page.goto(state().uiUrl);
  await expect(page.locator('[data-testid="tree-folder"][data-path="projects"]')).toBeVisible();

  // --- 新規作成 (サイドバーの + ボタン) ---
  await page.getByTestId('sidebar-new-note').click();
  await expect(page.getByTestId('new-note-dialog')).toBeVisible();
  await page.getByTestId('new-note-input').fill('E2E 新規ノート');
  await page.getByTestId('new-note-confirm').click();

  const created = page.locator('[data-testid="tree-item"][data-path="E2E 新規ノート.md"]');
  await expect(created).toBeVisible();
  await expect(created).toHaveClass(/active/); // 作成したノートがエディタに開く

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
  await expect(page.getByTestId('editor')).toContainText('新規ノートの本文です。'); // 内容は引き継がれる

  // リネームは再読み込み後も persist している (UI 経由で確認)
  await page.goto(state().uiUrl);
  await expect(page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]')).toBeVisible();

  // --- 削除 (右クリックメニュー → 確認ダイアログ) ---
  await page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('新規ノートの本文です。');
  await page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]').click({ button: 'right' });
  await page.getByTestId('context-delete').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await page.getByTestId('delete-confirm').click();

  await expect(page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]')).toHaveCount(0);
  // 開いていたノートを消したので empty state に落ちる
  await expect(page.getByTestId('editor-empty-state')).toBeVisible();

  await page.goto(state().uiUrl);
  await expect(page.locator('[data-testid="tree-item"][data-path="E2E リネーム済み.md"]')).toHaveCount(0);
});

test('[AC-Sa704c3-1-3] コンテキストメニューの「同じフォルダに新規ノート」と新規フォルダ作成', async ({ page }) => {
  await page.goto(state().uiUrl);

  // フォルダ行の右クリック → そのフォルダ内に新規ノート
  await page.locator('[data-testid="tree-folder"][data-path="projects"]').click({ button: 'right' });
  await expect(page.getByTestId('tree-context-menu')).toBeVisible();
  await page.getByTestId('context-new-note').click();
  await page.getByTestId('new-note-input').fill('E2E フォルダ内ノート');
  await page.getByTestId('new-note-confirm').click();
  await expect(
    page.locator('[data-testid="tree-item"][data-path="projects/E2E フォルダ内ノート.md"]'),
  ).toBeVisible();

  // 新規フォルダ → その中にノートを作ると永続化される
  await page.getByTestId('sidebar-new-folder').click();
  await page.getByTestId('new-folder-input').fill('e2e-folder');
  await page.getByTestId('new-folder-confirm').click();
  const folder = page.locator('[data-testid="tree-folder"][data-path="e2e-folder"]');
  await expect(folder).toBeVisible();

  await folder.click({ button: 'right' });
  await page.getByTestId('context-new-note').click();
  await page.getByTestId('new-note-input').fill('中のノート');
  await page.getByTestId('new-note-confirm').click();
  await expect(page.locator('[data-testid="tree-item"][data-path="e2e-folder/中のノート.md"]')).toBeVisible();

  // 再読み込み後もフォルダ + ノートが残る (ファイルとして永続化された)
  await page.goto(state().uiUrl);
  await expect(page.locator('[data-testid="tree-folder"][data-path="e2e-folder"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-item"][data-path="e2e-folder/中のノート.md"]')).toBeVisible();

  // 後片付け (UI 経由で削除 — 削除フローの追加検証を兼ねる)
  for (const p of ['projects/E2E フォルダ内ノート.md', 'e2e-folder/中のノート.md']) {
    await page.locator(`[data-testid="tree-item"][data-path="${p}"]`).click({ button: 'right' });
    await page.getByTestId('context-delete').click();
    await page.getByTestId('delete-confirm').click();
    await expect(page.locator(`[data-testid="tree-item"][data-path="${p}"]`)).toHaveCount(0);
  }
});

test('[AC-Sa704c3-1-2] 別プロセスの変更と競合したら警告ダイアログを出す (mtime 楽観的検出)', async ({ page }) => {
  const { uiUrl, apiUrl } = state();

  // 対象ノートを API で用意 (セットアップは UI バイパス可)
  await fetch(`${apiUrl}/api/notes/conflict-e2e.md`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'server v1\n' }),
  });

  await page.goto(uiUrl);
  await page.locator('[data-testid="tree-item"][data-path="conflict-e2e.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('server v1');

  // --- 再読込パス: 外部プロセス (エージェント想定) が同じノートを書き換える ---
  await new Promise((r) => setTimeout(r, 20)); // mtime 解像度対策
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

  // 上書き結果を UI の再読み込みで確認
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
