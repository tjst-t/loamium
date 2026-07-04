/**
 * Story Sf53ad6-3「埋め込みプレビューブロック」E2E 受け入れテスト。
 *
 * test-discipline Rule 2/4: 実ブラウザ → 実 Vite dev server → 実 Loamium サーバー →
 * 実ファイルシステム。fixtures は小さな実 PDF / txt / csv / json / バイナリを
 * 実アップロード API で vault へ置き、実プレビューを検証する。
 */
import { test, expect, type Page } from '@playwright/test';
import { readHarnessState } from '../harness/state.js';

const state = () => readHarnessState();

/**
 * 最小の実 PDF (1 ページ・空白)。xref オフセットを計算して正しく組み立てる —
 * ブラウザ内蔵ビューアが application/pdf として解釈できる実バイト列。
 */
function buildMinimalPdf(): Buffer {
  const header = '%PDF-1.4\n';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
  ];
  let offset = header.length;
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(offset);
    offset += o.length;
  }
  const xrefPos = offset;
  const pad = (n: number): string => String(n).padStart(10, '0');
  const xref =
    `xref\n0 4\n0000000000 65535 f \n` +
    offsets.map((o) => `${pad(o)} 00000 n \n`).join('');
  const trailer = `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${String(xrefPos)}\n%%EOF\n`;
  return Buffer.from(header + objs.join('') + xref + trailer, 'latin1');
}

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

async function uploadViaApi(rel: string, bytes: Buffer | string): Promise<void> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await fetch(`${state().apiUrl}/api/files/${encoded}?overwrite=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: typeof bytes === 'string' ? bytes : new Uint8Array(bytes),
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

test.beforeAll(async () => {
  // fixtures: 小さな実ファイル群を実アップロード API で配置する
  await uploadViaApi('assets/e2e-bench.pdf', buildMinimalPdf());
  await uploadViaApi(
    'assets/e2e-server.log',
    Array.from({ length: 42 }, (_, i) => `2026-07-04T09:00:${String(i).padStart(2, '0')} INFO log-line-${String(i + 1)}`).join('\n') + '\n',
  );
  await uploadViaApi('assets/e2e-data.csv', 'target,bs,iops\nnvme,4k,412000\nzfs,4k,268000\n');
  await uploadViaApi('assets/e2e-config.json', '{\n  "vault": "loamium-notes",\n  "mode": "full"\n}\n');
  await uploadViaApi('assets/e2e-backup.tar.zst', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5, 6, 7, 8]));
  await putNote('previews/e2e-埋め込み元.md', '# 埋め込み元\n\n正本はここに 1 回だけ書く。\n');
  await putNote(
    'previews/e2e-プレビュー.md',
    [
      '# プレビュー検証',
      '',
      '![[assets/e2e-bench.pdf]]',
      '',
      '![[assets/e2e-server.log]]',
      '',
      '![[assets/e2e-data.csv]]',
      '',
      '![[assets/e2e-config.json]]',
      '',
      '![[e2e-埋め込み元]]',
      '',
      '![[assets/e2e-backup.tar.zst]]',
      '',
      'アンカー行。',
      '',
    ].join('\n'),
  );
});

test('[AC-Sf53ad6-3-1] ![[file.pdf]] が PDF ビューアブロック (ブラウザ内蔵ビューア) として埋め込み表示される', async ({ page }) => {
  await openApp(page);
  await openNoteViaTree(page, 'previews/e2e-プレビュー.md');
  await editorLine(page, 'アンカー行').click();

  const block = page.locator(
    '[data-testid="file-embed"][data-kind="pdf"][data-path="assets/e2e-bench.pdf"]',
  );
  await expect(block).toBeVisible();
  await expect(block).toContainText('e2e-bench.pdf');

  // ブラウザ内蔵ビューア (iframe) が実サーバーの PDF を指す
  const frame = block.locator('iframe.pdf-frame');
  await expect(frame).toHaveAttribute('src', '/api/files/assets/e2e-bench.pdf');
  // 実サーバーがその src を application/pdf として配信している (ビューアが起動できる)
  const res = await fetch(`${state().apiUrl}/api/files/assets/e2e-bench.pdf`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  const bytes = Buffer.from(await res.arrayBuffer());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  await expect(block.getByTestId('file-embed-open-full')).toContainText('新しいタブで開く');
});

test('[AC-Sf53ad6-3-2] テキスト系 (.log/.csv/.json) は読み取り専用ブロックで、コード系はハイライト・長文は先頭 N 行 + 全体を開く', async ({ page }) => {
  await openApp(page);
  await openNoteViaTree(page, 'previews/e2e-プレビュー.md');
  await editorLine(page, 'アンカー行').click();

  // .log (42 行) は先頭 30 行 + 「全体を開く」
  const log = page.locator('[data-testid="file-embed"][data-path="assets/e2e-server.log"]');
  await expect(log).toBeVisible();
  await expect(log).toContainText('42 行 · 先頭 30 行を表示');
  await expect(log).toContainText('log-line-1');
  await expect(log).not.toContainText('log-line-42');
  await log.getByTestId('file-embed-open-full').click();
  await expect(log).toHaveAttribute('data-expanded', 'true');
  await expect(log).toContainText('log-line-42');

  // .csv は全行表示 (行番号付きの読み取り専用ブロック)
  const csv = page.locator('[data-testid="file-embed"][data-kind="text"][data-path="assets/e2e-data.csv"]');
  await expect(csv).toBeVisible();
  await expect(csv).toContainText('全 3 行');
  await expect(csv).toContainText('nvme,4k,412000');

  // .json はシンタックスハイライト (Shiki) 付き
  const json = page.locator('[data-testid="file-embed"][data-kind="text"][data-path="assets/e2e-config.json"]');
  await expect(json).toBeVisible();
  await expect(json.locator('pre.shiki')).toBeVisible();
  await expect(json).toContainText('"loamium-notes"');

  // 読み取り専用: ブロック本文をクリックするとソース記法表示に戻るだけ (編集はソースで行う)
  await csv.click();
  await expect(editorLine(page, '![[assets/e2e-data.csv]]')).toBeVisible();
});

test('[AC-Sf53ad6-3-3] ![[doc.md]] は transclusion と同一、プレビュー不能はファイルカード (名前・サイズ・DL リンク)', async ({ page }) => {
  await openApp(page);
  await openNoteViaTree(page, 'previews/e2e-プレビュー.md');
  await editorLine(page, 'アンカー行').click();

  // .md はノート transclusion (S9e5ca4-1 の embed-card と同一表示)
  const card = page.locator('[data-testid="embed-card"][data-target="previews/e2e-埋め込み元.md"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('正本はここに 1 回だけ書く。');
  await expect(card.getByTestId('embed-card-open')).toContainText('e2e-埋め込み元');

  // プレビュー不能 (.tar.zst) はファイルカード: 名前・サイズ・ダウンロードリンク
  const fileCard = page.locator(
    '[data-testid="file-embed"][data-kind="card"][data-path="assets/e2e-backup.tar.zst"]',
  );
  await expect(fileCard).toBeVisible();
  await expect(fileCard).toContainText('e2e-backup.tar.zst');
  await expect(fileCard).toContainText('12 B'); // 実ファイルサイズ
  const dl = fileCard.getByTestId('file-embed-download');
  await expect(dl).toHaveAttribute('href', '/api/files/assets/e2e-backup.tar.zst');
  await expect(dl).toHaveAttribute('download', 'e2e-backup.tar.zst');
  // ダウンロードリンクは実サーバーから実バイト列を返す
  const res = await fetch(`${state().apiUrl}/api/files/assets/e2e-backup.tar.zst`);
  expect(res.status).toBe(200);
  expect((await res.arrayBuffer()).byteLength).toBe(12);
});
