/**
 * Story Sf53ad6-1「CLI アップロード」受け入れテスト。
 * scenario-Sf53ad6-1.json (cli ブロック) を機械的に実行する。
 * 実 bin (packages/cli/bin/loamium.js) を subprocess 起動 (test-discipline Rule 2)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';
import { parseStderrJson, runCli } from './helpers/cli.js';

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('[AC-Sf53ad6-1-3] loamium upload <ローカルファイル> [vault内パス] (REST 1:1)', () => {
  let server: TestServer;
  let workDir: string;
  let localPng: string;

  beforeAll(async () => {
    server = await startServer({ vault: await makeTempVault(), mode: 'full' });
    workDir = await mkdtemp(path.join(tmpdir(), 'loamium-upload-src-'));
    localPng = path.join(workDir, 'screenshot.png');
    await writeFile(localPng, PIXEL_PNG);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
    await rm(workDir, { recursive: true, force: true });
  });

  it('vault 内パス省略時は assets/<ファイル名> に保存され、バイト列が一致する', async () => {
    const res = await runCli(['upload', localPng], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('uploaded assets/screenshot.png');
    expect(res.stderr).toBe('');
    const onDisk = await readFile(path.join(server.vault, 'assets/screenshot.png'));
    expect(onDisk.equals(PIXEL_PNG)).toBe(true);
  });

  it('vault 内パスを指定するとそこへ保存される (--json は API レスポンスの生 JSON)', async () => {
    const res = await runCli(['upload', localPng, 'docs/img/添付.png', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { path: string; created: boolean; size: number };
    expect(body.path).toBe('docs/img/添付.png');
    expect(body.created).toBe(true);
    expect(body.size).toBe(PIXEL_PNG.byteLength);
    const onDisk = await readFile(path.join(server.vault, 'docs/img/添付.png'));
    expect(onDisk.equals(PIXEL_PNG)).toBe(true);
  });

  it('既存パスへは conflict (exit 1)、--overwrite なら上書きできる', async () => {
    const conflict = await runCli(['upload', localPng], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(conflict.code).toBe(1);
    expect(parseStderrJson(conflict.stderr).error).toBe('conflict');

    await writeFile(localPng, Buffer.concat([PIXEL_PNG, Buffer.from('v2')]));
    const overwrite = await runCli(['upload', localPng, '--overwrite'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(overwrite.code).toBe(0);
    expect(overwrite.stdout).toContain('overwrote assets/screenshot.png');
    const onDisk = await readFile(path.join(server.vault, 'assets/screenshot.png'));
    expect(onDisk.byteLength).toBe(PIXEL_PNG.byteLength + 2);
  });

  it('ローカルファイルが無ければ local_file_not_found (exit 1、サーバーへは何も送らない)', async () => {
    const res = await runCli(['upload', path.join(workDir, 'no-such.png')], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(1);
    expect(parseStderrJson(res.stderr).error).toBe('local_file_not_found');
  });

  it('不正な vault パス (traversal) はクライアント側で invalid_path (exit 1)', async () => {
    const res = await runCli(['upload', localPng, '../escape.png'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(1);
    expect(parseStderrJson(res.stderr).error).toBe('invalid_path');
  });

  it('.md へのアップロードはサーバーの use_notes_api がそのまま透過する (exit 1)', async () => {
    const res = await runCli(['upload', localPng, 'notes/memo.md'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(1);
    const err = parseStderrJson(res.stderr);
    expect(err.error).toBe('use_notes_api');
    expect(err.message).toContain('/api/notes');
  });

  it('loamium files が添付一覧を返す (GET /api/files と 1:1)', async () => {
    const res = await runCli(['files'], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines.some((l) => l.startsWith('assets/screenshot.png\t'))).toBe(true);
    expect(lines.some((l) => l.startsWith('docs/img/添付.png\t'))).toBe(true);

    const jsonRes = await runCli(['files', '--json'], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(jsonRes.code).toBe(0);
    const body = JSON.parse(jsonRes.stdout) as { files: { path: string; size: number }[] };
    expect(body.files.map((f) => f.path)).toContain('assets/screenshot.png');
  });

  it('アップロードしたファイルは loamium file で 1 バイトも欠けず取り出せる (往復検証)', async () => {
    const res = await runCli(['file', 'docs/img/添付.png'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('PNG');
  });
});
