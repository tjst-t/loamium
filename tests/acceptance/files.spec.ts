/**
 * Story S9e5ca4-2「画像埋め込みとファイル配信」受け入れテスト。
 * scenario-S9e5ca4-2.json (api / cli ブロック) を機械的に実行する。
 * 実サーバー + 実 HTTP クライアント + 実 CLI subprocess (test-discipline Rule 2)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';
import { runCli } from './helpers/cli.js';

/** 1x1 の実 PNG (バイナリ配信のバイト一致検証用)。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function seedFile(vault: string, rel: string, content: Buffer | string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('[AC-S9e5ca4-2-1] GET /api/files/{path} — 読み取り専用配信', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'assets/pixel.png', PIXEL_PNG);
    await seedFile(vault, 'notes/hello.md', '# Hello\n\n本文。\n');
    await seedFile(vault, '.loamium/audit.log', '{"secret":"do-not-serve"}\n');
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('画像を Content-Type: image/png で配信し、バイト列がディスクと一致する', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/assets/pixel.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PIXEL_PNG)).toBe(true);
  });

  it('Markdown ファイルもテキストとして配信される (日本語パスの percent-encoding 含む)', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/notes/hello.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('# Hello\n\n本文。\n');
  });

  it('パス脱出 (percent-encoded traversal) は 400 invalid_path', async () => {
    // fetch はリテラル ../ を URL 段階で潰すため、percent-encode してサーバーへ届ける
    const res = await fetch(`${server.baseUrl}/api/files/..%2Fsecret.txt`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_path');

    const res2 = await fetch(`${server.baseUrl}/api/files/a%2F..%2F..%2Fetc%2Fpasswd`);
    expect(res2.status).toBe(400);
  });

  it('.loamium / .git など隠しセグメントは 404 (存在自体を隠す)', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/.loamium/audit.log`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message).not.toContain('audit'); // 内容・存在のヒントを漏らさない

    const res2 = await fetch(`${server.baseUrl}/api/files/.git/config`);
    expect(res2.status).toBe(404);
  });

  it('存在しないファイル・ディレクトリは 404', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/no-such-file.png`);
    expect(res.status).toBe(404);
    const dir = await fetch(`${server.baseUrl}/api/files/assets`);
    expect(dir.status).toBe(404);
  });

  it('書き込み系 (PUT/POST/DELETE) は存在せず、ファイルは変更されない', async () => {
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await fetch(`${server.baseUrl}/api/files/assets/pixel.png`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ content: 'x' }),
      });
      expect(res.status, `${method} must not be handled`).toBe(404);
    }
    const onDisk = await readFile(path.join(server.vault, 'assets/pixel.png'));
    expect(onDisk.equals(PIXEL_PNG)).toBe(true);
  });
});

describe('[AC-S9e5ca4-2-1] read-only モードでも GET /api/files は配信される', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'assets/pixel.png', PIXEL_PNG);
    server = await startServer({ vault, mode: 'read-only' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('mode=read-only で 200 (読むだけなので許可される)', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/assets/pixel.png`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PIXEL_PNG)).toBe(true);
  });
});

describe('[AC-S9e5ca4-2-1] CLI: loamium file <path> (REST 1:1)', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedFile(vault, 'assets/pixel.png', PIXEL_PNG);
    await seedFile(vault, 'docs/データ.txt', 'ファイル配信のテキスト内容\n2 行目\n');
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('stdout にバイト列をそのまま出す (exit 0)', async () => {
    const res = await runCli(['file', 'assets/pixel.png'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    // runCli の stdout は文字列連結だが、PNG ヘッダの識別文字列で実体を確認できる
    expect(res.stdout).toContain('PNG');
    expect(res.stderr).toBe('');
  });

  it('テキストファイルは内容が 1 バイトも欠けず stdout に出る (日本語パス)', async () => {
    const res = await runCli(['file', 'docs/データ.txt'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('ファイル配信のテキスト内容\n2 行目\n');
  });

  it('存在しないファイルは exit 1 + not_found の 1 行 JSON', async () => {
    const res = await runCli(['file', 'no-such.png'], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(res.code).toBe(1);
    const err = JSON.parse(res.stderr.trim()) as { error: string };
    expect(err.error).toBe('not_found');
  });

  it('traversal パスはクライアント側で invalid_path (exit 1)', async () => {
    const res = await runCli(['file', '../escape.png'], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(res.code).toBe(1);
    const err = JSON.parse(res.stderr.trim()) as { error: string };
    expect(err.error).toBe('invalid_path');
  });
});
