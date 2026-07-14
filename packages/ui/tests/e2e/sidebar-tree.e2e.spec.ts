/**
 * Story S79c210-1 E2E — サイドバーのノート フォルダツリー (フォルダ横断閲覧 /
 * asset 非表示 / ネスト作成)。Sf1a90a-3 の直近フラット一覧を置換する。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite → 実サーバー → 実ファイルシステム。
 * 一意なフォルダ名 (st-tree-e2e) を使い、共有 vault の他テストと衝突しないようにする。
 */
import { test, expect } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

const ROOT = 'st-tree-e2e';
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function encodePath(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function putNote(rel: string, content: string): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/notes/${encodePath(rel)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.ok).toBe(true);
}

async function uploadFile(rel: string, bytes: Buffer): Promise<void> {
  const res = await fetch(`${state().apiUrl}/api/files/${encodePath(rel)}?overwrite=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  expect(res.ok).toBe(true);
}

test('[AC-S79c210-1-1] サイドバーはフォルダツリーで、展開/折りたたみでフォルダ横断に全ノートへ辿れる', async ({
  page,
}) => {
  await putNote(`${ROOT}/top.md`, '# Top\n\n本文トップ\n');
  await putNote(`${ROOT}/sub/deep.md`, '# Deep\n\n本文ディープ\n');
  await putNote(`${ROOT}/sub/deep2.md`, '# Deep2\n\n本文ディープ2\n');

  await page.goto(state().uiUrl);
  await expect(page.getByTestId('file-tree')).toBeVisible();

  // フォルダが階層で表示される (直近フラット一覧ではない)
  const rootFolder = page.locator(`[data-testid="tree-folder"][data-path="${ROOT}"]`);
  const subFolder = page.locator(`[data-testid="tree-folder"][data-path="${ROOT}/sub"]`);
  await expect(rootFolder).toBeVisible();
  await expect(subFolder).toBeVisible();

  // フォルダ横断で全ノートに辿れる
  const top = page.locator(`[data-testid="tree-item"][data-path="${ROOT}/top.md"]`);
  const deep = page.locator(`[data-testid="tree-item"][data-path="${ROOT}/sub/deep.md"]`);
  await expect(top).toBeVisible();
  await expect(deep).toBeVisible();

  // ネストしたノートを開ける (ルーティングは /n/{path} で維持)
  await deep.click();
  await expect(page.getByTestId('editor')).toContainText('本文ディープ');
  await expect(page).toHaveURL(/\/n\/st-tree-e2e\/sub\/deep$/);

  // sub フォルダを折りたたむと配下ノートが隠れ、再展開で戻る
  await subFolder.click();
  await expect(subFolder).toHaveAttribute('aria-expanded', 'false');
  await expect(deep).toBeHidden();
  await subFolder.click();
  await expect(subFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(deep).toBeVisible();
});

test('[AC-S79c210-1-2] 非ノート asset はツリーに出ず /files に集約される', async ({ page }) => {
  await putNote(`${ROOT}-a/note.md`, '# A\n\n本文\n');
  await uploadFile(`${ROOT}-a/picture.png`, PIXEL_PNG);

  await page.goto(state().uiUrl);
  await expect(page.getByTestId('file-tree')).toBeVisible();

  // ノートはツリーに出る
  await expect(page.locator(`[data-testid="tree-item"][data-path="${ROOT}-a/note.md"]`)).toBeVisible();
  // asset (png) はサイドバーツリーに一切出ない (tree-item / tree-file とも)
  await expect(
    page.locator(`[data-testid="file-tree"] [data-path="${ROOT}-a/picture.png"]`),
  ).toHaveCount(0);

  // 「すべてのファイルを表示」→ /files に asset が集約される
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(
    page.locator(`[data-testid="file-row"][data-path="${ROOT}-a/picture.png"]`),
  ).toBeVisible();
});

test('[AC-S79c210-1-3] フォルダの中にフォルダとノートを作成でき、ネストが作れる', async ({
  page,
}) => {
  await putNote(`${ROOT}-b/seed.md`, '# Seed\n\n本文シード\n');

  await page.goto(state().uiUrl);
  const baseFolder = page.locator(`[data-testid="tree-folder"][data-path="${ROOT}-b"]`);
  await expect(baseFolder).toBeVisible();

  // フォルダを右クリック → 「このフォルダに新規フォルダ」
  await baseFolder.click({ button: 'right' });
  await expect(page.getByTestId('tree-context-menu')).toBeVisible();
  await page.getByTestId('context-new-folder').click();
  await page.getByTestId('new-folder-input').fill('nested');
  await page.getByTestId('new-folder-confirm').click();

  // 作成したネストフォルダがツリーに現れる (空フォルダは UI 状態として表示)
  const nested = page.locator(`[data-testid="tree-folder"][data-path="${ROOT}-b/nested"]`);
  await expect(nested).toBeVisible();

  // そのフォルダの中にノートを作る → フォルダが実体化しノートが開く
  // Sa10026-8: new-note-input → new-note-path (パス入力に統一)
  // context-new-note はフォルダを初期値に prefill するので、ファイル名を追記する
  await nested.click({ button: 'right' });
  await expect(page.getByTestId('tree-context-menu')).toBeVisible();
  await page.getByTestId('context-new-note').click();
  // input には既に "st-tree-e2e-b/nested/" が prefill されているので "inner" を追記
  await page.getByTestId('new-note-path').type('inner');
  await page.getByTestId('new-note-confirm').click();

  const inner = page.locator(`[data-testid="tree-item"][data-path="${ROOT}-b/nested/inner.md"]`);
  await expect(inner).toBeVisible();
  await expect(page).toHaveURL(/\/n\/st-tree-e2e-b\/nested\/inner$/);
});
