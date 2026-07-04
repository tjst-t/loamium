/**
 * Story Seac77a-1 一覧 API 受け入れテスト (AC-Seac77a-1-1)。
 *
 * ファイル/フォルダブラウザは「ノート(.md)と非ノートファイル(assets 等)の両方を
 * 名前・サイズ・更新日時付きで一覧」する。一覧 API は既存 2 本の統合:
 *   - GET /api/notes … ノート (path/title/folder/mtime/**size**)
 *   - GET /api/files … 添付 (path/size/mtime)
 * どちらも size/mtime を持ち、種別は .md か否かで一意に分かれる。UI はこの 2 本を
 * 統合してフォルダ横断で一覧・絞り込みする (decisions I1)。
 *
 * 実サーバー + 実 HTTP クライアント (test-discipline Rule 2 api)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

interface NoteMeta {
  path: string;
  title: string;
  folder: string;
  mtime: number;
  size: number;
}
interface FileMeta {
  path: string;
  size: number;
  mtime: number;
}

async function seed(vault: string, rel: string, content: Buffer | string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const HYDRA_BODY = '# Hydra 設計メモ\n\n本文です。\n';
const NESTED_BODY = '# ネスト\n\nsub フォルダのノート。\n';
const INBOX_BODY = '# inbox\n';
const CSV_BODY = 'a,b,c\n1,2,3\n';

describe('[AC-Seac77a-1-1] 一覧 API (ノート + ファイル) — size / mtime / 種別付き', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seed(vault, 'projects/Hydra 設計メモ.md', HYDRA_BODY);
    await seed(vault, 'projects/sub/nested.md', NESTED_BODY);
    await seed(vault, 'inbox.md', INBOX_BODY);
    await seed(vault, 'assets/network-topology.png', PIXEL_PNG);
    await seed(vault, 'assets/capacity.csv', CSV_BODY);
    await seed(vault, 'readme.txt', 'ルート直下のテキスト\n');
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('GET /api/notes は全ノートを path/title/folder/mtime/size 付きで返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: NoteMeta[] };
    const byPath = new Map(body.notes.map((n) => [n.path, n]));

    // ノートのみ (非 .md は含まない)
    expect(body.notes.every((n) => n.path.toLowerCase().endsWith('.md'))).toBe(true);
    expect(byPath.has('assets/network-topology.png')).toBe(false);
    expect(byPath.has('readme.txt')).toBe(false);

    const hydra = byPath.get('projects/Hydra 設計メモ.md');
    expect(hydra).toBeDefined();
    // サイズはディスク上のバイト数と一致する (名前・サイズ・更新日時の "サイズ")
    expect(hydra?.size).toBe(Buffer.byteLength(HYDRA_BODY, 'utf8'));
    expect(hydra?.folder).toBe('projects');
    expect(typeof hydra?.mtime).toBe('number');
    expect((hydra?.mtime ?? 0) > 0).toBe(true);

    // フォルダ階層 (フォルダツリーを辿るための folder メタ)
    expect(byPath.get('projects/sub/nested.md')?.folder).toBe('projects/sub');
    expect(byPath.get('projects/sub/nested.md')?.size).toBe(Buffer.byteLength(NESTED_BODY, 'utf8'));
    expect(byPath.get('inbox.md')?.folder).toBe('');
    expect(byPath.get('inbox.md')?.size).toBe(Buffer.byteLength(INBOX_BODY, 'utf8'));
  });

  it('GET /api/files は非ノートファイルを path/size/mtime 付きで返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: FileMeta[] };
    const byPath = new Map(body.files.map((f) => [f.path, f]));

    // 非 .md のみ (ノートは含まない)
    expect(body.files.every((f) => !f.path.toLowerCase().endsWith('.md'))).toBe(true);
    expect(byPath.has('projects/Hydra 設計メモ.md')).toBe(false);

    const png = byPath.get('assets/network-topology.png');
    expect(png).toBeDefined();
    expect(png?.size).toBe(PIXEL_PNG.byteLength);
    expect((png?.mtime ?? 0) > 0).toBe(true);

    expect(byPath.get('assets/capacity.csv')?.size).toBe(Buffer.byteLength(CSV_BODY, 'utf8'));
    // ルート直下の添付も列挙される (フォルダ横断)
    expect(byPath.has('readme.txt')).toBe(true);
  });

  it('2 本を統合すると vault 全体のノート + 添付を size/mtime 付きで網羅する', async () => {
    const [notesRes, filesRes] = await Promise.all([
      fetch(`${server.baseUrl}/api/notes`).then((r) => r.json() as Promise<{ notes: NoteMeta[] }>),
      fetch(`${server.baseUrl}/api/files`).then((r) => r.json() as Promise<{ files: FileMeta[] }>),
    ]);
    const allPaths = new Set([
      ...notesRes.notes.map((n) => n.path),
      ...filesRes.files.map((f) => f.path),
    ]);
    // journal 等の自動生成が無い状態で、seed した 6 ファイルが全て揃う
    for (const p of [
      'projects/Hydra 設計メモ.md',
      'projects/sub/nested.md',
      'inbox.md',
      'assets/network-topology.png',
      'assets/capacity.csv',
      'readme.txt',
    ]) {
      expect(allPaths.has(p)).toBe(true);
    }
    // 統合後の全エントリが size と mtime を持つ (一覧の "サイズ・更新日時" 要件)
    const combined = [
      ...notesRes.notes.map((n) => ({ size: n.size, mtime: n.mtime })),
      ...filesRes.files.map((f) => ({ size: f.size, mtime: f.mtime })),
    ];
    for (const e of combined) {
      expect(typeof e.size).toBe('number');
      expect(typeof e.mtime).toBe('number');
    }
  });
});
