/**
 * Story Sf53ad6-2「UI アップロード (D&D / ペースト)」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム (一時 vault)。ネットワークモックは使わない。
 * ハーネスは LOAMIUM_MAX_UPLOAD=5mb で起動している (サイズ超過の実検証用)。
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

/** 1x1 の実 PNG。 */
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

async function uploadViaApi(rel: string, bytes: Buffer): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/files/${encoded}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  expect(res.status).toBe(201);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(state().uiUrl);
  await expect(page.locator('.breadcrumb .current')).not.toHaveText('ノートが開かれていません');
  await expect(page.getByTestId('editor')).toBeVisible();
}

function editorLine(page: Page, text: string) {
  return page.locator('[data-testid="editor"] .cm-line', { hasText: text }).first();
}

/** クリップボード貼り付け (合成 ClipboardEvent + 実 File)。 */
async function pasteFile(
  page: Page,
  file: { name: string; type: string; b64?: string; size?: number },
): Promise<void> {
  await page.evaluate((f) => {
    const bytes =
      f.b64 !== undefined
        ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
        : new Uint8Array(f.size ?? 16).fill(66);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], f.name, { type: f.type }));
    const target = document.querySelector('.cm-content');
    if (target === null) throw new Error('editor content not found');
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, file);
}

/** エディタ座標へのドロップ (合成 DragEvent + 実 File)。 */
async function dropFile(page: Page, file: { name: string; type: string; text: string }): Promise<void> {
  const box = await page.locator('.cm-content').boundingBox();
  if (box === null) throw new Error('editor not visible');
  await page.evaluate(
    ({ f, x, y }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([f.text], f.name, { type: f.type }));
      const target = document.querySelector('.cm-content');
      if (target === null) throw new Error('editor content not found');
      target.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      );
    },
    { f: file, x: box.x + box.width / 2, y: box.y + 10 },
  );
}

test('[AC-Sf53ad6-2-1] 画像のクリップボード貼り付けで assets/ にアップロードされ、カーソル位置に ![[パス]] が挿入される', async ({ page }) => {
  await openApp(page);
  // ジャーナル末尾へ本文を作ってカーソル位置を明確にする
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('貼り付け位置マーカー: ');

  await pasteFile(page, { name: 'e2e-shot.png', type: 'image/png', b64: PIXEL_PNG.toString('base64') });

  // カーソル位置 (マーカーの直後) に挿入される
  await expect(editorLine(page, '貼り付け位置マーカー: ![[assets/e2e-shot.png]]')).toBeVisible();

  // 実ファイルが vault に書かれ、バイト列が一致する
  await expect
    .poll(async () => {
      try {
        const buf = await readFile(path.join(state().vault, 'assets/e2e-shot.png'));
        return buf.equals(PIXEL_PNG);
      } catch {
        return false;
      }
    })
    .toBe(true);

  // 非 .md はサイドバーには出ず、/files 一覧に画像種別で現れる (S79c210-1)
  await expect(
    page.locator('[data-testid="file-tree"] [data-path="assets/e2e-shot.png"]'),
  ).toHaveCount(0);
  await page.getByTestId('sidebar-show-all').click();
  const row = page.locator('[data-testid="file-row"][data-path="assets/e2e-shot.png"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.fn-ico')).toHaveClass(/ico-img/);
});

test('[AC-Sf53ad6-2-1] ファイルのドラッグ&ドロップでもアップロードと ![[パス]] 挿入が起きる', async ({ page }) => {
  await openApp(page);
  await page.locator('.cm-content').click();

  await dropFile(page, { name: 'e2e-dropped.txt', type: 'text/plain', text: 'dropped-content\n' });

  await expect(page.getByTestId('editor')).toContainText('![[assets/e2e-dropped.txt]]');
  await expect
    .poll(async () => {
      try {
        return await readFile(path.join(state().vault, 'assets/e2e-dropped.txt'), 'utf8');
      } catch {
        return null;
      }
    })
    .toBe('dropped-content\n');
  // 非 .md はサイドバーに出ず /files 一覧で確認できる (S79c210-1)
  await expect(
    page.locator('[data-testid="file-tree"] [data-path="assets/e2e-dropped.txt"]'),
  ).toHaveCount(0);
  await page.getByTestId('sidebar-show-all').click();
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/e2e-dropped.txt"]'),
  ).toBeVisible();
});

test('[AC-Sf53ad6-2-2] 名前衝突は連番リネーム (image-1.png) され、renamed トーストが出る', async ({ page }) => {
  // 事前に同名ファイルを実サーバーへ置いておく
  await uploadViaApi('assets/e2e-collide.png', PIXEL_PNG);

  await openApp(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await pasteFile(page, { name: 'e2e-collide.png', type: 'image/png', b64: PIXEL_PNG.toString('base64') });

  await expect(page.getByTestId('editor')).toContainText('![[assets/e2e-collide-1.png]]');
  const toast = page.locator('[data-testid="upload-toast"][data-kind="renamed"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('e2e-collide-1.png');

  const onDisk = await readFile(path.join(state().vault, 'assets/e2e-collide-1.png'));
  expect(onDisk.equals(PIXEL_PNG)).toBe(true);
});

test('[AC-Sf53ad6-2-2] サイズ超過 (LOAMIUM_MAX_UPLOAD) は実サーバーの 413 がエラートーストになり、何も挿入されない', async ({ page }) => {
  await openApp(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');

  // ハーネスの上限 5MB を超える 6MB をブラウザ内で生成して貼り付ける
  await pasteFile(page, { name: 'e2e-huge.bin', type: 'application/octet-stream', size: 6 * 1024 * 1024 });

  const toast = page.locator('[data-testid="upload-toast"][data-kind="error"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('アップロードに失敗しました');
  await expect(toast).toContainText('e2e-huge.bin');
  await expect(page.getByTestId('editor')).not.toContainText('e2e-huge');
  await expect(stat(path.join(state().vault, 'assets/e2e-huge.bin'))).rejects.toThrow();
});

test('[AC-Sf53ad6-2-3] /files の非 .md はプレビュー、リネームは ![[リンク]] 追従、削除も既存操作と同様', async ({ page }) => {
  // 実サーバー経由で添付と参照ノートを用意する
  await uploadViaApi('assets/e2e-manage.png', PIXEL_PNG);
  await putNote(
    'previews/添付管理.md',
    '# 添付管理\n\n![[e2e-manage.png]]\n\nフルパス: ![[assets/e2e-manage.png]]\n',
  );

  await openApp(page);
  // 添付管理は /files に集約 (S79c210-1: 非 .md はサイドバーに出さない)
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);

  const item = page.locator('[data-testid="file-row"][data-path="assets/e2e-manage.png"]');
  await expect(item).toBeVisible();

  // --- プレビュー (画像が実サーバーからデコードされる) ---
  await item.getByTestId('file-preview-btn').click();
  const pane = page.getByTestId('files-preview-pane');
  await expect(pane).toBeVisible();
  const img = pane.locator('[data-testid="embed-image"] img');
  await expect(img).toBeVisible();
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(1);

  // --- リネーム: ![[e2e-manage.png]] / ![[assets/e2e-manage.png]] の両方が追従する ---
  await item.getByTestId('file-rename-btn').click();
  const input = page.getByTestId('rename-input');
  await expect(input).toHaveValue('e2e-manage.png');
  await input.fill('e2e-managed-renamed.png');
  await page.getByTestId('rename-confirm').click();

  const renamed = page.locator('[data-testid="file-row"][data-path="assets/e2e-managed-renamed.png"]');
  await expect(renamed).toBeVisible();
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/e2e-manage.png"]'),
  ).toHaveCount(0);

  // ディスク上のノートのリンクが書き換わっている (basename 一意 → 最短表記)
  await expect
    .poll(async () => readFile(path.join(state().vault, 'previews/添付管理.md'), 'utf8'))
    .toContain('![[e2e-managed-renamed.png]]');
  const noteText = await readFile(path.join(state().vault, 'previews/添付管理.md'), 'utf8');
  expect(noteText).not.toContain('e2e-manage.png]]');
  // ファイル実体も移動済み
  const moved = await readFile(path.join(state().vault, 'assets/e2e-managed-renamed.png'));
  expect(moved.equals(PIXEL_PNG)).toBe(true);

  // ノートを開くと埋め込みが新パスで解決される (壊れない) — /files のノート行から開く
  await page.locator('[data-testid="file-row"][data-path="previews/添付管理.md"]').click();
  await editorLine(page, '# 添付管理').click();
  await expect(
    page.locator('[data-testid="embed-image"][data-path="assets/e2e-managed-renamed.png"]').first(),
  ).toBeVisible();

  // --- 削除: /files へ戻り、確認ダイアログ経由でディスクからも消える ---
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  await renamed.getByTestId('file-delete-btn').click();
  await expect(page.getByTestId('delete-dialog')).toContainText('ファイルを削除');
  await page.getByTestId('delete-confirm').click();
  await expect(renamed).toHaveCount(0);
  await expect
    .poll(async () => {
      try {
        await stat(path.join(state().vault, 'assets/e2e-managed-renamed.png'));
        return 'exists';
      } catch {
        return 'gone';
      }
    })
    .toBe('gone');
});
