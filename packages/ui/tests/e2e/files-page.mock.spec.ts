/**
 * Story Seac77a-1 mock テスト (ファイル/フォルダブラウザのエッジ・削除確認・エラー)。
 * page.route で全 /api/* をモックする。受け入れ条件の本検証は
 * files-page.e2e.spec.ts (実サーバー) が行う。
 *
 * 検証観点:
 *  - 空 vault → files-empty、file-row 0、files-count "0 件"
 *  - 一覧 + 名前絞り込み (ノート + 添付を size/mtime 付きで表示)
 *  - 削除確認: delete-dialog を開き、キャンセルで消えず、確定で DELETE → 一覧から消える
 *  - /api/notes 失敗でもページは壊れず、取得できた添付は表示され app-error に漏れない
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';
import { installCatchAll, json } from '../harness/mock-helpers.js';

interface NoteMock {
  path: string;
  title: string;
  tags: string[];
  folder: string;
  mtime: number;
  size: number;
}
interface FileMock {
  path: string;
  size: number;
  mtime: number;
}

const NOTES: NoteMock[] = [
  { path: 'projects/Hydra 設計メモ.md', title: 'Hydra 設計メモ', tags: [], folder: 'projects', mtime: 5000, size: 1200 },
  { path: 'inbox.md', title: 'inbox', tags: [], folder: '', mtime: 2000, size: 40 },
];
const FILES: FileMock[] = [
  { path: 'assets/network-topology.png', size: 1258301, mtime: 9000 },
  { path: 'assets/capacity.csv', size: 18000, mtime: 3000 },
];

interface Mocks {
  unexpected: string[];
  deleted: string[];
}

async function openFiles(
  page: Page,
  opts: { notes?: NoteMock[]; files?: FileMock[]; failNotes?: boolean } = {},
): Promise<Mocks> {
  const unexpected = await installCatchAll(page);
  const deleted: string[] = [];
  // 削除後の一覧反映のため mutable なコピーを保持する
  const notes = [...(opts.notes ?? [])];
  const files = [...(opts.files ?? [])];

  await page.route('**/api/notes', (route) => {
    if (opts.failNotes === true) {
      void route.fulfill(json({ error: 'internal_error', message: 'index unavailable' }, 500));
      return;
    }
    void route.fulfill(json({ notes }));
  });
  await page.route('**/api/notes/**', (route) => {
    if (route.request().method() === 'DELETE') {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(
        /^\/api\/notes\//,
        '',
      );
      const i = notes.findIndex((n) => n.path === rel);
      if (i >= 0) notes.splice(i, 1);
      deleted.push(rel);
      void route.fulfill(json({ path: rel, deleted: true }));
      return;
    }
    void route.fulfill(json({ error: 'unmocked', message: 'note GET not expected' }, 500));
  });
  await page.route('**/api/files', (route) => {
    void route.fulfill(json({ files }));
  });
  await page.route('**/api/files/**', (route) => {
    if (route.request().method() === 'DELETE') {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(
        /^\/api\/files\//,
        '',
      );
      const i = files.findIndex((f) => f.path === rel);
      if (i >= 0) files.splice(i, 1);
      deleted.push(rel);
      void route.fulfill(json({ path: rel, deleted: true }));
      return;
    }
    // 画像等の配信 (プレビュー) — 本 mock では使わないが catch-all を避ける
    void route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([]) });
  });

  await page.goto(`${readHarnessState().uiUrl}/files`);
  await expect(page.getByTestId('files-list')).toBeVisible();
  return { unexpected, deleted };
}

test('[MOCK] 空 vault は files-empty を表示し、file-row は出ない', async ({ page }) => {
  const { unexpected } = await openFiles(page, { notes: [], files: [] });
  await expect(page.getByTestId('files-empty')).toBeVisible();
  await expect(page.getByTestId('file-row')).toHaveCount(0);
  await expect(page.getByTestId('files-count')).toContainText('0 件');
  expect(unexpected).toEqual([]);
});

test('[MOCK] ノート + 添付が一覧表示され、名前で絞り込める', async ({ page }) => {
  const { unexpected } = await openFiles(page, { notes: NOTES, files: FILES });
  await expect(page.getByTestId('file-row')).toHaveCount(4);
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/network-topology.png"]'),
  ).toContainText('PNG 画像');
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/network-topology.png"]'),
  ).toContainText('1.2 MB');

  // 名前で絞り込む → capacity だけ残る
  await page.getByTestId('files-filter').fill('capacity');
  await expect(page.getByTestId('file-row')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/capacity.csv"]'),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('[MOCK] 削除確認: キャンセルで残り、確定で DELETE され一覧から消える', async ({ page }) => {
  const { unexpected, deleted } = await openFiles(page, { notes: NOTES, files: FILES });
  const targetRow = page.locator('[data-testid="file-row"][data-path="assets/capacity.csv"]');
  await expect(targetRow).toBeVisible();

  // 削除ボタン → 確認ダイアログ (見出しは「ファイルを削除」)
  await targetRow.getByTestId('file-delete-btn').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await expect(page.getByTestId('delete-dialog')).toContainText('ファイルを削除');

  // キャンセル → まだ消えない
  await page.getByTestId('delete-cancel').click();
  await expect(page.getByTestId('delete-dialog')).toHaveCount(0);
  await expect(targetRow).toBeVisible();
  expect(deleted).toEqual([]);

  // もう一度開いて確定 → DELETE され一覧から消える
  await targetRow.getByTestId('file-delete-btn').click();
  await page.getByTestId('delete-confirm').click();
  await expect(targetRow).toHaveCount(0);
  await expect(page.getByTestId('file-row')).toHaveCount(3);
  expect(deleted).toEqual(['assets/capacity.csv']);
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('[MOCK] /api/notes 失敗でも取得できた添付は表示され、app-error に漏れない', async ({ page }) => {
  await openFiles(page, { failNotes: true, files: FILES });
  // ノートは取れないが添付 2 件は一覧に出る
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="file-row"][data-path="assets/network-topology.png"]'),
  ).toBeVisible();
  await expect(page.getByTestId('app-error')).toHaveCount(0);
});
