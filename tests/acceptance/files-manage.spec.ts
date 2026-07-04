/**
 * 添付ファイルの削除・リネーム API (Sf53ad6-2 のサーバー側基盤)。
 * UI 経由の受け入れ検証は packages/ui/tests/e2e/upload.e2e.spec.ts
 * ([AC-Sf53ad6-2-3]) が行う。ここは API 単体の実 HTTP 検証 (test-discipline Rule 6)。
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

async function seed(vault: string, rel: string, content: Buffer | string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function encode(rel: string): string {
  return rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

describe('DELETE /api/files/{path} — 添付削除', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seed(vault, 'assets/gone.png', 'png-bytes');
    await seed(vault, 'keep.md', '# keep\n');
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('添付を削除でき、監査ログに file.delete が記録される', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/assets/gone.png`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ path: 'assets/gone.png', deleted: true });
    await expect(stat(path.join(server.vault, 'assets/gone.png'))).rejects.toThrow();
    const audit = await readFile(path.join(server.vault, '.loamium/audit.log'), 'utf8');
    expect(audit).toContain('"op":"file.delete"');
  });

  it('存在しないファイルは 404、.md は 400 use_notes_api、隠しセグメントは 400', async () => {
    const missing = await fetch(`${server.baseUrl}/api/files/assets/gone.png`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    const md = await fetch(`${server.baseUrl}/api/files/keep.md`, { method: 'DELETE' });
    expect(md.status).toBe(400);
    expect(((await md.json()) as { error: string }).error).toBe('use_notes_api');
    await expect(readFile(path.join(server.vault, 'keep.md'), 'utf8')).resolves.toContain('# keep');
    const hidden = await fetch(`${server.baseUrl}/api/files/.loamium%2Faudit.log`, {
      method: 'DELETE',
    });
    expect(hidden.status).toBe(400);
  });

  it('read-only モードでは 403 で削除されない', async () => {
    const vault = await makeTempVault();
    await seed(vault, 'assets/safe.png', 'bytes');
    const ro = await startServer({ vault, mode: 'read-only' });
    try {
      const res = await fetch(`${ro.baseUrl}/api/files/assets/safe.png`, { method: 'DELETE' });
      expect(res.status).toBe(403);
      await expect(readFile(path.join(vault, 'assets/safe.png'), 'utf8')).resolves.toBe('bytes');
    } finally {
      await ro.stop();
      await cleanupVault(vault);
    }
  });
});

describe('POST /api/files/{path}/rename — 添付リネーム + ![[リンク]] 追従', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seed(vault, 'assets/photo.png', 'photo-bytes');
    await seed(vault, 'assets/other.png', 'other-bytes');
    await seed(
      vault,
      'notes/日誌.md',
      '# 日誌\n\n![[photo.png]]\n\nフルパス参照: ![[assets/photo.png]]\n\n別ファイル: ![[other.png]]\n\n```\nフェンス内は不変: ![[photo.png]]\n```\n',
    );
    await seed(vault, 'notes/リンクなし.md', '# リンクなし\n\n本文のみ。\n');
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('ファイルが移動し、解決先が旧パスの ![[リンク]] だけが書き換わる (フェンス内不変)', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/${encode('assets/photo.png')}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPath: 'assets/rack-photo.png' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      oldPath: string;
      path: string;
      updatedNotes: { path: string; links: number }[];
      updatedLinks: number;
    };
    expect(body.oldPath).toBe('assets/photo.png');
    expect(body.path).toBe('assets/rack-photo.png');
    expect(body.updatedLinks).toBe(2);
    expect(body.updatedNotes).toEqual([{ path: 'notes/日誌.md', links: 2 }]);

    // ディスク: 移動済み・バイト列そのまま
    await expect(stat(path.join(server.vault, 'assets/photo.png'))).rejects.toThrow();
    await expect(
      readFile(path.join(server.vault, 'assets/rack-photo.png'), 'utf8'),
    ).resolves.toBe('photo-bytes');

    // リンク: basename 一意なので最短表記へ。other.png とフェンス内は不変
    const note = await readFile(path.join(server.vault, 'notes/日誌.md'), 'utf8');
    expect(note).toContain('![[rack-photo.png]]');
    expect(note).toContain('フルパス参照: ![[rack-photo.png]]');
    expect(note).toContain('![[other.png]]');
    expect(note).toContain('フェンス内は不変: ![[photo.png]]');
    expect(note).not.toContain('![[assets/photo.png]]');

    // 監査ログ
    const audit = await readFile(path.join(server.vault, '.loamium/audit.log'), 'utf8');
    expect(audit).toContain('"op":"file.rename"');
  });

  it('リネーム先が既存なら 409 で何も変わらない', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/files/${encode('assets/rack-photo.png')}/rename`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPath: 'assets/other.png' }),
      },
    );
    expect(res.status).toBe(409);
    await expect(
      readFile(path.join(server.vault, 'assets/rack-photo.png'), 'utf8'),
    ).resolves.toBe('photo-bytes');
    await expect(readFile(path.join(server.vault, 'assets/other.png'), 'utf8')).resolves.toBe(
      'other-bytes',
    );
  });

  it('存在しないファイルは 404、.md への/からのリネームは 400 use_notes_api', async () => {
    const missing = await fetch(`${server.baseUrl}/api/files/${encode('assets/no.png')}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPath: 'assets/yes.png' }),
    });
    expect(missing.status).toBe(404);

    const toMd = await fetch(
      `${server.baseUrl}/api/files/${encode('assets/rack-photo.png')}/rename`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPath: 'assets/rack.md' }),
      },
    );
    expect(toMd.status).toBe(400);
    expect(((await toMd.json()) as { error: string }).error).toBe('use_notes_api');

    const fromMd = await fetch(`${server.baseUrl}/api/files/${encode('notes/日誌.md')}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPath: 'notes/renamed.md' }),
    });
    expect(fromMd.status).toBe(400);
  });

  it('リネーム後のリンクはインデックスにも追従する (バックリンク更新)', async () => {
    // notes/日誌.md の ![[rack-photo.png]] はノートではないのでバックリンク対象外だが、
    // インデックス refresh が走っても検索が壊れないことを確認する
    const res = await fetch(`${server.baseUrl}/api/search?q=${encodeURIComponent('日誌')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { path: string }[] };
    expect(body.results.some((r) => r.path === 'notes/日誌.md')).toBe(true);
  });
});
