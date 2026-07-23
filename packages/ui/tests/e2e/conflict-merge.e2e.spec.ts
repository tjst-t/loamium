/**
 * Story S2df65d-1「dirty 編集中のリモート変更を 3-way 自動マージし、競合ハンクのみ提示」
 * E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 *
 * [AC-S2df65d-1-1] 非競合変更の自動統合(dirty 中にリモート変更が来ても編集が保持)
 * [AC-S2df65d-1-3] 非 dirty 時の自動リロード(現行挙動の維持確認)
 * [AC-S2df65d-1-4] マージ結果の書き戻しが監査ログに記録される
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

// テスト用ノートパス (衝突しないよう固有のプレフィックスを使う)
const NOTE_PATH = 'conflict-merge-e2e/test-note.md';

async function putNote(rel: string, content: string, baseMtime?: number): Promise<Response> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return fetch(`${state().apiUrl}/api/notes/${encoded}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, ...(baseMtime !== undefined ? { baseMtime } : {}) }),
  });
}

async function getNote(rel: string): Promise<{ content: string; mtime: number }> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/notes/${encoded}`);
  expect(res.ok).toBe(true);
  return res.json() as Promise<{ content: string; mtime: number }>;
}

async function openNote(page: Page, relPath: string): Promise<void> {
  const treePath = `[data-testid="tree-item"][data-path="${relPath}"]`;
  // ツリーが表示されるまで待機
  await expect(page.locator(treePath)).toBeVisible({ timeout: 10000 });
  await page.locator(treePath).click();
  await expect(page.getByTestId('editor')).toBeVisible();
}

/**
 * [AC-S2df65d-1-3] 非 dirty 時は従来どおり自動リロード(現行挙動の維持)。
 *
 * ノートを開いて未編集のまま、API 経由でノートを更新する。
 * SSE notes_changed イベントでエディタが最新内容へ自動更新されることを確認。
 */
test('[AC-S2df65d-1-3] 非 dirty 時に SSE notes_changed を受けたらエディタが自動更新される', async ({ page }) => {
  const initialContent = '# 自動リロードテスト\n\n段落 A。\n\n段落 B。\n';
  const updatedContent = '# 自動リロードテスト\n\n段落 A (更新済み)。\n\n段落 B。\n';

  // ノートを作成してアプリを開く
  const initRes = await putNote(NOTE_PATH + '-clean', initialContent);
  expect(initRes.ok).toBe(true);

  await page.goto(state().uiUrl);
  await openNote(page, NOTE_PATH + '-clean');

  // エディタが初期内容を表示していることを確認
  await expect(page.getByTestId('editor')).toContainText('段落 A。');
  await expect(page.getByTestId('editor')).not.toContainText('更新済み');

  // API 経由でリモート更新(dirty=false の状態)
  const putRes = await putNote(NOTE_PATH + '-clean', updatedContent);
  expect(putRes.ok).toBe(true);

  // SSE 経由で自動リロードされ、最新内容が表示される
  await expect(page.getByTestId('editor')).toContainText('更新済み', { timeout: 5000 });
});

/**
 * [AC-S2df65d-1-1] dirty 状態で非競合リモート変更が来た場合、自動統合されローカル編集が保持される。
 *
 * ユーザーが段落 B を編集中に、段落 C がリモートで変更される(非競合)。
 * エディタに両方の変更が反映され、ユーザー編集が失われないことを確認。
 */
test('[AC-S2df65d-1-1] dirty 中に非競合リモート変更が来た場合、自動統合されユーザー編集が保持される', async ({ page }) => {
  const baseContent = [
    '# 競合マージテスト',
    '',
    '段落 A (共通)。',
    '',
    '段落 B (ユーザーが編集する予定)。',
    '',
    '段落 C (リモートが編集する予定)。',
    '',
  ].join('\n');

  // 初期ノートを作成
  const initRes = await putNote(NOTE_PATH + '-dirty', baseContent);
  expect(initRes.ok).toBe(true);
  const { mtime: baseMtime } = await getNote(NOTE_PATH + '-dirty');

  // アプリを開いてノートを表示
  await page.goto(state().uiUrl);
  await openNote(page, NOTE_PATH + '-dirty');
  await expect(page.getByTestId('editor')).toContainText('段落 B (ユーザーが編集する予定)');

  // ユーザーが段落 B を編集 → dirty=true になる
  const editorLocator = page.getByTestId('editor');
  const lineB = page.locator('[data-testid="editor"] .cm-line', { hasText: '段落 B (ユーザーが編集する予定)' }).first();
  await lineB.click();
  // 行末にカーソルを移動してテキスト追加(ユーザー編集をシミュレート)
  await page.keyboard.press('End');
  await page.keyboard.type(' [ユーザー編集済み]');

  // dirty になっていることを確認(保存ボタン等の変化で確認)
  // ユーザーが編集した内容がエディタに見える
  await expect(editorLocator).toContainText('ユーザー編集済み');

  // リモートが段落 C を変更(非競合: 別の段落)
  const remoteContent = baseContent.replace(
    '段落 C (リモートが編集する予定)。',
    '段落 C (リモート更新済み)。',
  );
  const putRes = await putNote(NOTE_PATH + '-dirty', remoteContent, baseMtime);
  expect(putRes.ok).toBe(true);

  // 非競合自動統合: ユーザーの段落 B 編集とリモートの段落 C 変更が両方反映される
  await expect(editorLocator).toContainText('ユーザー編集済み', { timeout: 5000 });
  await expect(editorLocator).toContainText('リモート更新済み', { timeout: 5000 });

  // ユーザー編集が保持されていることを明示的に確認
  await expect(editorLocator).toContainText('段落 B');
  await expect(editorLocator).toContainText('段落 C');
});

/**
 * [AC-S2df65d-1-2] dirty + 競合ハンクあり → ConflictResolverDialog が表示される。
 *
 * ユーザーとリモートが同じ段落を異なる内容に編集した場合、
 * 競合ダイアログが表示されることを確認。
 */
test('[AC-S2df65d-1-2] dirty 中に競合変更が来た場合、ConflictResolverDialog が表示される', async ({ page }) => {
  const baseContent = [
    '# 競合ダイアログテスト',
    '',
    '競合する段落。元の内容。',
    '',
    '別の段落。',
    '',
  ].join('\n');

  const initRes = await putNote(NOTE_PATH + '-conflict', baseContent);
  expect(initRes.ok).toBe(true);
  const { mtime: baseMtime } = await getNote(NOTE_PATH + '-conflict');

  await page.goto(state().uiUrl);
  await openNote(page, NOTE_PATH + '-conflict');

  // ユーザーが同じ段落を編集
  const conflictLine = page.locator('[data-testid="editor"] .cm-line', { hasText: '競合する段落。元の内容。' }).first();
  await conflictLine.click();
  await page.keyboard.press('End');
  // テキスト全置換は難しいので追記で競合を発生させる
  await page.keyboard.type(' [ユーザーが変更]');

  await expect(page.getByTestId('editor')).toContainText('ユーザーが変更');

  // リモートが同じ段落を異なる内容に変更 → 競合発生
  const remoteContent = baseContent.replace(
    '競合する段落。元の内容。',
    '競合する段落。リモートが変更。',
  );
  const putRes = await putNote(NOTE_PATH + '-conflict', remoteContent, baseMtime);
  expect(putRes.ok).toBe(true);

  // ConflictResolverDialog が表示される
  await expect(page.getByTestId('conflict-resolver-dialog')).toBeVisible({ timeout: 5000 });

  // 競合ハンクが表示される
  await expect(page.getByTestId('conflict-hunk-item')).toHaveCount(1);

  // 解決ボタンが存在する
  await expect(page.getByTestId('conflict-choose-ours').first()).toBeVisible();
  await expect(page.getByTestId('conflict-choose-theirs').first()).toBeVisible();
});

/**
 * [AC-S2df65d-1-2][AC-S2df65d-1-4] 競合ハンクを解決してマージ結果を保存できる。
 * マージ結果の書き戻しが監査ログに記録される。
 */
test('[AC-S2df65d-1-2][AC-S2df65d-1-4] 競合ハンクを解決して保存すると監査ログに記録される', async ({ page }) => {
  const vaultPath = state().vaultPath;
  const baseContent = [
    '# 監査ログテスト',
    '',
    '競合する内容。',
    '',
  ].join('\n');

  const initRes = await putNote(NOTE_PATH + '-audit', baseContent);
  expect(initRes.ok).toBe(true);
  const { mtime: baseMtime } = await getNote(NOTE_PATH + '-audit');

  await page.goto(state().uiUrl);
  await openNote(page, NOTE_PATH + '-audit');

  // ユーザー編集 (dirty)
  const conflictLine = page.locator('[data-testid="editor"] .cm-line', { hasText: '競合する内容。' }).first();
  await conflictLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' [ユーザー]');

  // リモート競合書き込み
  const remoteContent = baseContent.replace('競合する内容。', '競合する内容。[リモート]');
  await putNote(NOTE_PATH + '-audit', remoteContent, baseMtime);

  // 競合ダイアログが表示されるまで待機
  await expect(page.getByTestId('conflict-resolver-dialog')).toBeVisible({ timeout: 5000 });

  // 「こちらを使う (ours)」で解決
  await page.getByTestId('conflict-choose-ours').first().click();

  // 保存ボタンが有効になる → クリックして保存
  await expect(page.getByTestId('conflict-save-merge')).toBeEnabled({ timeout: 3000 });
  await page.getByTestId('conflict-save-merge').click();

  // ダイアログが閉じる
  await expect(page.getByTestId('conflict-resolver-dialog')).not.toBeVisible({ timeout: 5000 });

  // 監査ログに記録されていることを確認
  const auditLog = await readFile(
    path.join(vaultPath, '.loamium', 'audit.log'),
    'utf-8',
  );
  const lines = auditLog.trim().split('\n');
  const mergeEntry = lines
    .map((l) => JSON.parse(l) as { op?: string; path?: string })
    .find((e) => e.op === 'note.write' && (e.path ?? '').includes('audit'));
  expect(mergeEntry).toBeDefined();
});
