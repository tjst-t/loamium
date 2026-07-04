/**
 * Story Sf53ad6-1「ファイルアップロード API」受け入れテスト。
 * scenario-Sf53ad6-1.json (api ブロック) を機械的に実行する。
 * 実サーバー + 実 HTTP クライアント (test-discipline Rule 2)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';

/** 1x1 の実 PNG (バイト一致検証用)。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function upload(base: string, rel: string, body: Buffer | string, qs = ''): Promise<Response> {
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return fetch(`${base}/api/files/${encoded}${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
}

async function readAudit(vault: string): Promise<{ op: string; path: string; result: string }[]> {
  const raw = await readFile(path.join(vault, '.loamium/audit.log'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { op: string; path: string; result: string });
}

describe('[AC-Sf53ad6-1-1] POST /api/files/{path} — アップロード・上書き保護・監査ログ', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ vault: await makeTempVault(), mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('raw body でアップロードでき、ディスクのバイト列が一致する (201 created)', async () => {
    const res = await upload(server.baseUrl, 'assets/pixel.png', PIXEL_PNG);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; created: boolean; size: number; mtime: number };
    expect(body.path).toBe('assets/pixel.png');
    expect(body.created).toBe(true);
    expect(body.size).toBe(PIXEL_PNG.byteLength);
    const onDisk = await readFile(path.join(server.vault, 'assets/pixel.png'));
    expect(onDisk.equals(PIXEL_PNG)).toBe(true);
    // アップロードしたファイルは GET /api/files でそのまま配信される
    const served = await fetch(`${server.baseUrl}/api/files/assets/pixel.png`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(PIXEL_PNG)).toBe(true);
  });

  it('既存パスへの再アップロードは overwrite フラグなしなら 409 で、ファイルは変わらない', async () => {
    const res = await upload(server.baseUrl, 'assets/pixel.png', 'not-a-png');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('conflict');
    expect(body.message).toContain('overwrite');
    const onDisk = await readFile(path.join(server.vault, 'assets/pixel.png'));
    expect(onDisk.equals(PIXEL_PNG)).toBe(true);
  });

  it('?overwrite=true なら上書きできる (200)', async () => {
    const res = await upload(server.baseUrl, 'assets/pixel.png', 'replaced-bytes', '?overwrite=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; size: number };
    expect(body.created).toBe(false);
    expect(body.size).toBe(Buffer.byteLength('replaced-bytes'));
    const onDisk = await readFile(path.join(server.vault, 'assets/pixel.png'), 'utf8');
    expect(onDisk).toBe('replaced-bytes');
  });

  it('日本語パス (percent-encoded) にもアップロードできる', async () => {
    const res = await upload(server.baseUrl, 'assets/画面写真.png', PIXEL_PNG);
    expect(res.status).toBe(201);
    const onDisk = await readFile(path.join(server.vault, 'assets/画面写真.png'));
    expect(onDisk.equals(PIXEL_PNG)).toBe(true);
  });

  it('GET /api/files が非 .md ファイル一覧 (path/size/mtime) を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string; size: number; mtime: number }[] };
    const paths = body.files.map((f) => f.path);
    expect(paths).toContain('assets/pixel.png');
    expect(paths).toContain('assets/画面写真.png');
    const pixel = body.files.find((f) => f.path === 'assets/画面写真.png');
    expect(pixel?.size).toBe(PIXEL_PNG.byteLength);
    expect(pixel?.mtime).toBeGreaterThan(0);
  });

  it('書き込みは監査ログ (.loamium/audit.log) に file.write として記録される', async () => {
    const entries = await readAudit(server.vault);
    const writes = entries.filter((e) => e.op === 'file.write');
    expect(writes.some((e) => e.path === 'assets/pixel.png' && e.result === 'ok')).toBe(true);
    // 409 拒否も result: error で記録される
    expect(writes.some((e) => e.path === 'assets/pixel.png' && e.result === 'error')).toBe(true);
  });
});

describe('[AC-Sf53ad6-1-1] read-only / append-only モードのアップロードは 403', () => {
  it('mode=read-only は 403 forbidden (denied が監査ログに残り、ファイルは作られない)', async () => {
    const vault = await makeTempVault();
    const server = await startServer({ vault, mode: 'read-only' });
    try {
      const res = await upload(server.baseUrl, 'assets/blocked.png', PIXEL_PNG);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('forbidden');
      await expect(stat(path.join(vault, 'assets/blocked.png'))).rejects.toThrow();
      const entries = await readAudit(vault);
      expect(entries.some((e) => e.result === 'denied')).toBe(true);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('mode=append-only も 403 (アップロードは追記ではない)', async () => {
    const vault = await makeTempVault();
    const server = await startServer({ vault, mode: 'append-only' });
    try {
      const res = await upload(server.baseUrl, 'assets/blocked.png', PIXEL_PNG);
      expect(res.status).toBe(403);
      await expect(stat(path.join(vault, 'assets/blocked.png'))).rejects.toThrow();
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });
});

describe('[AC-Sf53ad6-1-2] 不正パス・.md・サイズ超過は 4xx で拒否される', () => {
  let server: TestServer;

  beforeAll(async () => {
    // サイズ上限テストのため LOAMIUM_MAX_UPLOAD を 1KB に絞って起動する
    server = await startServer({
      vault: await makeTempVault(),
      mode: 'full',
      env: { LOAMIUM_MAX_UPLOAD: '1kb' },
    });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('パス脱出 (percent-encoded traversal) は 400 invalid_path', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/..%2Fescape.png`, {
      method: 'POST',
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_path');
    const res2 = await fetch(`${server.baseUrl}/api/files/a%2F..%2F..%2Fetc%2Fpasswd`, {
      method: 'POST',
      body: 'x',
    });
    expect(res2.status).toBe(400);
  });

  it('.loamium/ など隠しセグメント配下へのアップロードは 400 invalid_path', async () => {
    for (const rel of ['.loamium%2Fevil.bin', '.git%2Fconfig', 'a%2F.obsidian%2Fx.json']) {
      const res = await fetch(`${server.baseUrl}/api/files/${rel}`, { method: 'POST', body: 'x' });
      expect(res.status, rel).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_path');
    }
  });

  it('.md はアップロードできず、notes API へ誘導される (400 use_notes_api)', async () => {
    const res = await upload(server.baseUrl, 'notes/hello.md', '# hi');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('use_notes_api');
    expect(body.message).toContain('/api/notes');
    await expect(stat(path.join(server.vault, 'notes/hello.md'))).rejects.toThrow();
  });

  it('LOAMIUM_MAX_UPLOAD を超えるボディは 413 too_large で、ファイルは作られない', async () => {
    const big = Buffer.alloc(2048, 0x41); // 上限 1KB に対して 2KB
    const res = await upload(server.baseUrl, 'assets/big.bin', big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('too_large');
    expect(body.message).toContain('LOAMIUM_MAX_UPLOAD');
    await expect(stat(path.join(server.vault, 'assets/big.bin'))).rejects.toThrow();
  });

  it('上限以内のアップロードは通る (境界確認)', async () => {
    const ok = Buffer.alloc(1024, 0x42);
    const res = await upload(server.baseUrl, 'assets/ok.bin', ok);
    expect(res.status).toBe(201);
  });

  it('ディレクトリと衝突するパスは 409 conflict', async () => {
    await mkdir(path.join(server.vault, 'assets/dir'), { recursive: true });
    const res = await upload(server.baseUrl, 'assets/dir', 'x');
    expect(res.status).toBe(409);
    // 既存ファイルを親セグメントに含むパスも 409
    await writeFile(path.join(server.vault, 'assets/leaf.bin'), 'leaf');
    const res2 = await upload(server.baseUrl, 'assets/leaf.bin/child.png', 'x');
    expect(res2.status).toBe(409);
  });
});
