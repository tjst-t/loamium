/**
 * Story Sa8ee62-1「サーバー側エクスポートパイプライン」受け入れテスト。
 *
 * test-discipline Rule 2: 実サーバーをサブプロセスで起動し、実 HTTP クライアント + 実 CLI
 * バイナリで叩いてエンドツーエンドを検証する。
 *
 * [AC-Sa8ee62-1-1] GET /api/notes/{path}/export?format=pdf|html の動作
 * [AC-Sa8ee62-1-2] CLI `loamium export <path> --format pdf|html` が同一パイプラインを使う (REST/CLI 1:1)
 * [AC-Sa8ee62-1-3] HTML の決定論的出力 / PDF マジックバイト確認 / vault ファイル無改変の検証
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

let server: TestServer;
let vaultRoot: string;

/** テスト用ノートの Markdown 内容 (frontmatter + 本文) */
const NOTE_PATH = 'notes/export-test.md';
const NOTE_CONTENT = [
  '---',
  'title: Export Test Note',
  'tags: [export, test]',
  '---',
  '',
  '# Export Heading One',
  '',
  'This is a test paragraph for export.',
  '',
  '## Second Heading',
  '',
  '- item one',
  '- item two',
  '',
].join('\n');

/** CLI 呼び出しヘルパー (LOAMIUM_URL をテストサーバーに向ける) */
function cli(args: string[]): ReturnType<typeof runCli> {
  return runCli(args, { env: { LOAMIUM_URL: server.baseUrl } });
}

beforeAll(async () => {
  vaultRoot = await makeTempVault();
  await mkdir(path.join(vaultRoot, 'notes'), { recursive: true });
  await writeFile(path.join(vaultRoot, NOTE_PATH), NOTE_CONTENT, 'utf8');
  server = await startServer({ vault: vaultRoot });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(vaultRoot);
});

// ---------------------------------------------------------------------------
// [AC-Sa8ee62-1-1] GET /api/notes/{path}/export?format=html
// ---------------------------------------------------------------------------

describe('[AC-Sa8ee62-1-1] GET /api/notes/{path}/export — HTML', () => {
  it('format=html — 200 と text/html を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('format=html — 応答ボディが <!DOCTYPE html> で始まる', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    expect(text.trim()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('format=html — <h1> が Markdown 見出しを含む', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    // AC-Sa8ee62-1-3: HTML output is deterministic (contains expected <h1>)
    expect(text).toContain('<h1>Export Heading One</h1>');
  });

  it('format=html — <h2> が第 2 見出しを含む', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    expect(text).toContain('<h2>Second Heading</h2>');
  });

  it('format=html — <title> に frontmatter の title が使われる', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    expect(text).toContain('<title>Export Test Note</title>');
  });

  it('format=html — 同一入力に対して決定論的 (2 回呼んで同じ結果) [AC-Sa8ee62-1-3]', async () => {
    const [r1, r2] = await Promise.all([
      fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`),
      fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`),
    ]);
    const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
    expect(t1).toBe(t2);
  });

  it('format=html — charset=utf-8 が Content-Type に含まれる', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
  });

  it('format=html — <meta charset="utf-8"> を含む', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    expect(text).toContain('<meta charset="utf-8">');
  });

  it('format=html — <style> ブロックを含む (テーマ CSS)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    expect(text).toContain('<style>');
  });

  it('format=html — <body> タグを含む', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);
    const text = await res.text();
    expect(text).toContain('<body>');
    expect(text).toContain('</body>');
  });
});

// ---------------------------------------------------------------------------
// [AC-Sa8ee62-1-1] GET /api/notes/{path}/export?format=pdf
// ---------------------------------------------------------------------------

describe('[AC-Sa8ee62-1-1] GET /api/notes/{path}/export — PDF', () => {
  it('format=pdf — 200 と application/pdf を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
  }, 60_000);

  it('format=pdf — レスポンスボディが %PDF- マジックバイトで始まる [AC-Sa8ee62-1-3]', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=pdf`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PDF マジックバイト: %PDF- (0x25 0x50 0x44 0x46 0x2D)
    const magic = String.fromCharCode(...bytes.slice(0, 5));
    expect(magic).toBe('%PDF-');
  }, 60_000);

  it('format=pdf — PDF サイズが非ゼロ (実際に内容がある) [AC-Sa8ee62-1-3]', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=pdf`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000); // 最低限の PDF は 1KB 超
  }, 60_000);

  it('format=pdf — content-disposition に attachment が含まれる', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=pdf`);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  }, 60_000);

  it('format=pdf (デフォルト) — format クエリパラメータを省略すると PDF を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const magic = String.fromCharCode(...bytes.slice(0, 5));
    expect(magic).toBe('%PDF-');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// [AC-Sa8ee62-1-1] エラーケース
// ---------------------------------------------------------------------------

describe('[AC-Sa8ee62-1-1] エラーケース', () => {
  it('format に無効な値を指定すると 400 を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=docx`);
    expect(res.status).toBe(400);
  });

  it('存在しないノートは 404 を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/nonexistent/file.md/export?format=html`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// [AC-Sa8ee62-1-3] vault ファイル無改変の確認
// ---------------------------------------------------------------------------

describe('[AC-Sa8ee62-1-3] vault ファイル無改変', () => {
  it('HTML エクスポート後も vault の .md ファイルバイトが変化しない', async () => {
    const filePath = path.join(vaultRoot, NOTE_PATH);
    const beforeBytes = await readFile(filePath);
    const beforeMtime = (await stat(filePath)).mtimeMs;

    await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);

    const afterBytes = await readFile(filePath);
    const afterMtime = (await stat(filePath)).mtimeMs;

    // バイト内容が変化していないこと
    expect(Buffer.compare(beforeBytes, afterBytes)).toBe(0);
    // mtime が変化していないこと (ファイル書き込みがないことの追加証拠)
    expect(afterMtime).toBe(beforeMtime);
  });

  it('PDF エクスポート後も vault の .md ファイルバイトが変化しない', async () => {
    const filePath = path.join(vaultRoot, NOTE_PATH);
    const beforeBytes = await readFile(filePath);
    const beforeMtime = (await stat(filePath)).mtimeMs;

    await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=pdf`);

    const afterBytes = await readFile(filePath);
    const afterMtime = (await stat(filePath)).mtimeMs;

    expect(Buffer.compare(beforeBytes, afterBytes)).toBe(0);
    expect(afterMtime).toBe(beforeMtime);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// [AC-Sa8ee62-1-2] CLI `loamium export <path> --format html|pdf`
// ---------------------------------------------------------------------------

describe('[AC-Sa8ee62-1-2] CLI loamium export <path>', () => {
  it('--format html — exit 0 で stdout に HTML が出力される', async () => {
    const result = await cli(['export', NOTE_PATH, '--format', 'html']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('<h1>Export Heading One</h1>');
  });

  it('--format html — stdout の出力が REST API の HTML レスポンスと同一 (REST/CLI 1:1)', async () => {
    const [cliResult, httpRes] = await Promise.all([
      cli(['export', NOTE_PATH, '--format', 'html']),
      fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`),
    ]);
    expect(cliResult.code).toBe(0);
    expect(httpRes.status).toBe(200);
    const httpText = await httpRes.text();
    // CLI stdout (バイナリセーフだが html はテキスト)
    expect(cliResult.stdout.trim()).toBe(httpText.trim());
  });

  it('--format pdf -o <file> — ファイルが %PDF- で始まる PDF として書き出される [AC-Sa8ee62-1-3]', async () => {
    const outFile = path.join(tmpdir(), `loamium-export-test-${Date.now()}.pdf`);
    const result = await cli(['export', NOTE_PATH, '--format', 'pdf', '-o', outFile]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');

    const pdfBytes = await readFile(outFile);
    const magic = pdfBytes.slice(0, 5).toString('ascii');
    expect(magic).toBe('%PDF-');
    expect(pdfBytes.byteLength).toBeGreaterThan(1000);
  }, 60_000);

  it('--format pdf -o <file> — stdout にはファイルパスのメッセージが出る', async () => {
    const outFile = path.join(tmpdir(), `loamium-export-msg-${Date.now()}.pdf`);
    const result = await cli(['export', NOTE_PATH, '--format', 'pdf', '-o', outFile]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(outFile);
  }, 60_000);

  it('無効な --format は exit 2 (使い方エラー)', async () => {
    const result = await cli(['export', NOTE_PATH, '--format', 'docx']);
    expect(result.code).toBe(2);
    expect(result.stderr).toBeTruthy();
  });

  it('引数なしは exit 2 (使い方エラー)', async () => {
    const result = await cli(['export']);
    expect(result.code).toBe(2);
  });

  it('存在しないノートは exit 1 で stderr にエラー JSON が出る', async () => {
    const result = await cli(['export', 'nonexistent/note.md', '--format', 'html']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBeTruthy();
    const err = JSON.parse(result.stderr.trim()) as { error: string; message: string };
    expect(err.error).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// [AC-Sa8ee62-1-2] 監査ログへの記録確認
// ---------------------------------------------------------------------------

describe('[AC-Sa8ee62-1-2] 監査ログ (note.export)', () => {
  it('エクスポート後に audit.log に note.export エントリが記録される', async () => {
    // まず HTML エクスポートを実行
    await fetch(`${server.baseUrl}/api/notes/${NOTE_PATH}/export?format=html`);

    // .loamium/audit.log を読んでエントリを確認
    const auditPath = path.join(vaultRoot, '.loamium', 'audit.log');
    // audit.log は非同期書き込みなので少し待つ
    await new Promise((r) => setTimeout(r, 200));

    const auditContent = await readFile(auditPath, 'utf8');
    const lines = auditContent.trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as { op: string; path: string; result: string });
    const exportEntries = entries.filter((e) => e.op === 'note.export');
    expect(exportEntries.length).toBeGreaterThan(0);
    expect(exportEntries[exportEntries.length - 1]?.path).toBe(NOTE_PATH);
    expect(exportEntries[exportEntries.length - 1]?.result).toBe('ok');
  });
});
