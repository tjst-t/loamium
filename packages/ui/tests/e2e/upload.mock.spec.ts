/**
 * Story Sf53ad6-2 mock テスト (アップロードのエラー・エッジケース)。
 * page.route で全 /api/* をモックする (gui-spec-Sf53ad6-2.json 参照)。
 * 受け入れ条件の本検証は upload.e2e.spec.ts (実サーバー) が行う。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

const DATE = '2026-07-03';
const JOURNAL_PATH = `journals/${DATE}.md`;
const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface FileMetaMock {
  path: string;
  size: number;
  mtime: number;
}

/** 共通セットアップ: ジャーナルを開き、ノート保存 (autosave PUT) も受ける。 */
async function openApp(
  page: Page,
  opts: { files?: FileMetaMock[]; journal?: string } = {},
): Promise<string[]> {
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => {
    void route.fulfill(json({ notes: [] }));
  });
  await page.route('**/api/journal', (route) => {
    const content = opts.journal ?? 'アンカー行。\n';
    void route.fulfill(
      json({
        date: DATE,
        path: JOURNAL_PATH,
        content,
        frontmatter: null,
        body: content,
        created: false,
        mtime: 1000,
      }),
    );
  });
  // 挿入後の自動保存 PUT を受ける (mock では常に成功)
  await page.route(`**/api/notes/journals/**`, (route) => {
    if (route.request().method() === 'PUT') {
      void route.fulfill(json({ path: JOURNAL_PATH, created: false, mtime: 2000 }));
      return;
    }
    void route.fallback();
  });
  if (opts.files !== undefined) {
    const files = opts.files;
    await page.route('**/api/files', (route) => {
      void route.fulfill(json({ files }));
    });
  }
  await page.goto(readHarnessState().uiUrl);
  await expect(page.getByTestId('editor')).toBeVisible();
  return unexpected;
}

/** エディタへ画像ファイルをクリップボード貼り付けする (合成 ClipboardEvent)。 */
async function pasteFile(
  page: Page,
  file: { name: string; type: string; b64?: string; size?: number },
): Promise<void> {
  await page.evaluate((f) => {
    const bytes =
      f.b64 !== undefined
        ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
        : new Uint8Array(f.size ?? 16).fill(65);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], f.name, { type: f.type }));
    const target = document.querySelector('.cm-content');
    if (target === null) throw new Error('editor content not found');
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, file);
}

test('[MOCK] 貼り付けアップロード成功で ![[assets/パス]] が挿入され、POST ボディは実バイト列', async ({ page }) => {
  const unexpected = await openApp(page, { files: [] });
  const posts: { url: string; size: number }[] = [];
  await page.route('**/api/files/**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posts.push({ url: req.url(), size: req.postDataBuffer()?.byteLength ?? 0 });
      void route.fulfill(
        json({ path: 'assets/shot.png', created: true, size: 70, mtime: 3000 }, 201),
      );
      return;
    }
    void route.fallback();
  });

  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).click();
  await pasteFile(page, { name: 'shot.png', type: 'image/png', b64: PIXEL_PNG_B64 });

  await expect(page.getByTestId('editor')).toContainText('![[assets/shot.png]]');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toContain('/api/files/assets/shot.png');
  expect(posts[0]?.size).toBeGreaterThan(0); // 実バイト列が送られている
  expect(unexpected).toEqual([]);
});

test('[MOCK] 名前衝突 (409) は連番リネームでリトライし、renamed トーストを出す', async ({ page }) => {
  const unexpected = await openApp(page, { files: [] });
  const attempts: string[] = [];
  await page.route('**/api/files/**', (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      void route.fallback();
      return;
    }
    const rel = decodeURIComponent(new URL(req.url()).pathname.replace(/^\/api\/files\//, ''));
    attempts.push(rel);
    if (rel === 'assets/image.png') {
      void route.fulfill(json({ error: 'conflict', message: 'file already exists' }, 409));
      return;
    }
    void route.fulfill(json({ path: rel, created: true, size: 70, mtime: 3000 }, 201));
  });

  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).click();
  await pasteFile(page, { name: 'image.png', type: 'image/png', b64: PIXEL_PNG_B64 });

  await expect(page.getByTestId('editor')).toContainText('![[assets/image-1.png]]');
  expect(attempts).toEqual(['assets/image.png', 'assets/image-1.png']);
  const toast = page.locator('[data-testid="upload-toast"][data-kind="renamed"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('image-1.png');
  expect(unexpected).toEqual([]);
});

test('[MOCK] サイズ超過 (413) はエラートーストで通知し、![[...]] は挿入されない', async ({ page }) => {
  const unexpected = await openApp(page, { files: [] });
  await page.route('**/api/files/**', (route) => {
    if (route.request().method() !== 'POST') {
      void route.fallback();
      return;
    }
    void route.fulfill(
      json(
        { error: 'too_large', message: 'upload exceeds the size limit (LOAMIUM_MAX_UPLOAD)' },
        413,
      ),
    );
  });

  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).click();
  await pasteFile(page, { name: 'huge.bin', type: 'application/octet-stream', size: 64 });

  const toast = page.locator('[data-testid="upload-toast"][data-kind="error"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('アップロードに失敗しました');
  await expect(toast).toContainText('huge.bin');
  await expect(page.getByTestId('editor')).not.toContainText('![[');
  // エディタは操作可能なまま
  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(unexpected).toEqual([]);
});

test('[MOCK] 権限エラー (403 read-only) もエラートーストになり、リトライループしない', async ({ page }) => {
  const unexpected = await openApp(page, { files: [] });
  let postCount = 0;
  await page.route('**/api/files/**', (route) => {
    if (route.request().method() !== 'POST') {
      void route.fallback();
      return;
    }
    postCount += 1;
    void route.fulfill(
      json({ error: 'forbidden', message: 'mode=read-only: write operations are not allowed' }, 403),
    );
  });

  await page.locator('[data-testid="editor"] .cm-line', { hasText: 'アンカー行' }).click();
  await pasteFile(page, { name: 'blocked.png', type: 'image/png', b64: PIXEL_PNG_B64 });

  const toast = page.locator('[data-testid="upload-toast"][data-kind="error"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('forbidden');
  expect(postCount).toBe(1); // 409 以外はリトライしない
  expect(unexpected).toEqual([]);
});

test('[MOCK] 非 .md はサイドバーツリーに出ず /files に種別付きで並び、プレビューが開く', async ({ page }) => {
  const files: FileMetaMock[] = [
    { path: 'assets/rack.png', size: 70, mtime: 1 },
    { path: 'assets/report.pdf', size: 1024, mtime: 2 },
    { path: 'assets/data.csv', size: 64, mtime: 3 },
  ];
  const unexpected = await openApp(page, { files });
  await page.route('**/api/files/assets/**', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(PIXEL_PNG_B64, 'base64'),
      });
      return;
    }
    void route.fallback();
  });

  // 非 .md はサイドバーのフォルダツリーに一切出ない (S79c210-1: asset は /files へ集約)
  await expect(page.locator('[data-testid="file-tree"] [data-testid="tree-file"]')).toHaveCount(0);

  // 「すべてのファイルを表示」→ /files に非 .md が種別付きで並ぶ
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  // #6 直下ナビ: 添付は assets/ 配下。assets フォルダへ潜る
  await page.locator('[data-testid="folder-row"][data-path="assets"]').click();
  const png = page.locator('[data-testid="file-row"][data-path="assets/rack.png"]');
  await expect(png).toBeVisible();
  // アイコンの種別区別 (画像=ico-img / PDF=ico-pdf / データ=ico-data)
  await expect(png.locator('.fn-ico')).toHaveClass(/ico-img/);
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/report.pdf"] .fn-ico'),
  ).toHaveClass(/ico-pdf/);
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/data.csv"] .fn-ico'),
  ).toHaveClass(/ico-data/);

  await png.getByTestId('file-preview-btn').click();
  const pane = page.getByTestId('files-preview-pane');
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-testid="embed-image"][data-path="assets/rack.png"]')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 添付のリネーム・削除は /files から files API を叩き、一覧が追従する', async ({ page }) => {
  let files: FileMetaMock[] = [{ path: 'assets/old.png', size: 70, mtime: 1 }];
  const unexpected = await installCatchAll(page);
  await page.route('**/api/notes', (route) => void route.fulfill(json({ notes: [] })));
  await page.route('**/api/journal', (route) => {
    void route.fulfill(
      json({
        date: DATE,
        path: JOURNAL_PATH,
        content: '',
        frontmatter: null,
        body: '',
        created: false,
        mtime: 1000,
      }),
    );
  });
  await page.route('**/api/files', (route) => void route.fulfill(json({ files })));
  const calls: string[] = [];
  await page.route('**/api/files/**', (route) => {
    const req = route.request();
    const rel = decodeURIComponent(new URL(req.url()).pathname.replace(/^\/api\/files\//, ''));
    if (req.method() === 'POST' && rel.endsWith('/rename')) {
      const body = JSON.parse(req.postData() ?? '{}') as { newPath?: string };
      calls.push(`rename ${rel.replace(/\/rename$/, '')} -> ${body.newPath ?? ''}`);
      files = [{ path: body.newPath ?? '', size: 70, mtime: 2 }];
      void route.fulfill(
        json({
          oldPath: 'assets/old.png',
          path: body.newPath ?? '',
          mtime: 2,
          updatedNotes: [],
          updatedLinks: 0,
        }),
      );
      return;
    }
    if (req.method() === 'DELETE') {
      calls.push(`delete ${rel}`);
      files = [];
      void route.fulfill(json({ path: rel, deleted: true }));
      return;
    }
    void route.fallback();
  });

  await page.goto(readHarnessState().uiUrl);
  // 添付のリネーム/削除 UI は /files に集約 (S79c210-1)
  await page.getByTestId('sidebar-show-all').click();
  await expect(page).toHaveURL(/\/files$/);
  // #6 直下ナビ: assets フォルダへ潜る
  await page.locator('[data-testid="folder-row"][data-path="assets"]').click();
  const item = page.locator('[data-testid="file-row"][data-path="assets/old.png"]');
  await expect(item).toBeVisible();

  // リネーム: 行のリネームボタン → リネームダイアログ (拡張子込みの初期値)
  await item.getByTestId('file-rename-btn').click();
  const input = page.getByTestId('rename-input');
  await expect(input).toHaveValue('old.png');
  await expect(page.getByTestId('rename-link-note')).toContainText('![[リンク]]');
  await input.fill('new.png');
  await page.getByTestId('rename-confirm').click();
  const renamed = page.locator('[data-testid="file-row"][data-path="assets/new.png"]');
  await expect(renamed).toBeVisible();
  expect(calls).toContain('rename assets/old.png -> assets/new.png');

  // 削除: 行の削除ボタン → 確認ダイアログ (「ファイルを削除」)
  await renamed.getByTestId('file-delete-btn').click();
  await expect(page.getByTestId('delete-dialog')).toContainText('ファイルを削除');
  await page.getByTestId('delete-confirm').click();
  await expect(page.locator('[data-testid="file-row"][data-path="assets/new.png"]')).toHaveCount(0);
  expect(calls).toContain('delete assets/new.png');
  expect(unexpected).toEqual([]);
});
