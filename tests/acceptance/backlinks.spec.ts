/**
 * S31ba00-2 バックリンク解決 — 受け入れテスト。
 * 実サーバー (tsx サブプロセス) を実 HTTP クライアントで叩く (test-discipline Rule 2: api)。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

interface BacklinksResponse {
  path: string;
  backlinks: {
    source: string;
    links: { raw: string; heading: string | null; line: number; context: string }[];
  }[];
}

let server: TestServer;
let vault: string;

/** vault 直下の全 .md ファイルの中身を再帰的に読む */
async function readAllNotes(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.name.endsWith('.md')) out.set(abs, await readFile(abs, 'utf8'));
    }
  };
  await walk(dir);
  return out;
}

const SOURCES = {
  'notes/design.md': '# 設計\n\n[[hydra]] の監査ログを参照。\n',
  'notes/journal-ref.md': 'きのうの作業: [[notes/hydra#設計|設計メモ]] を更新した。\n',
  'notes/other.md': '[[loamium]] だけにリンクする。\n',
} as const;

beforeAll(async () => {
  vault = await makeTempVault();
  await mkdir(path.join(vault, 'notes'), { recursive: true });
  await mkdir(path.join(vault, 'ノート'), { recursive: true });
  await writeFile(path.join(vault, 'notes/hydra.md'), '# Hydra\n\n## 設計\n本文。\n', 'utf8');
  await writeFile(path.join(vault, 'notes/isolated.md'), '誰もリンクしない。\n', 'utf8');
  await writeFile(path.join(vault, 'loamium.md'), 'ルート直下ノート。\n', 'utf8');
  for (const [rel, content] of Object.entries(SOURCES)) {
    await writeFile(path.join(vault, rel), content, 'utf8');
  }
  // NFC 正規形のターゲットノート + NFD ゆれ・拡張子省略・heading 付きでリンクする元ノート
  await writeFile(path.join(vault, 'ノート/概要.md'), '# 概要\n\n## 設計\n中身。\n', 'utf8');
  await writeFile(
    path.join(vault, 'linkers.md'),
    [
      `NFD リンク: [[${'ノート/概要'.normalize('NFD')}]]`,
      'heading 付き: [[概要#設計]]',
      '拡張子付き: [[概要.md]]',
      '',
    ].join('\n'),
    'utf8',
  );
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(vault);
});

describe('[AC-S31ba00-2-1] GET /api/backlinks lists linking notes with context', () => {
  it('returns all notes linking to the target, with line context', async () => {
    const res = await fetch(`${server.baseUrl}/api/backlinks?path=notes/hydra.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BacklinksResponse;
    expect(body.path).toBe('notes/hydra.md');
    const sources = body.backlinks.map((b) => b.source);
    expect(sources).toContain('notes/design.md'); // [[hydra]] (ファイル名のみ)
    expect(sources).toContain('notes/journal-ref.md'); // [[notes/hydra#設計|設計メモ]]
    expect(sources).not.toContain('notes/other.md');

    const design = body.backlinks.find((b) => b.source === 'notes/design.md');
    expect(design?.links[0]).toMatchObject({
      raw: '[[hydra]]',
      line: 3,
      context: '[[hydra]] の監査ログを参照。',
    });
    const journalRef = body.backlinks.find((b) => b.source === 'notes/journal-ref.md');
    expect(journalRef?.links[0]?.heading).toBe('設計');
    expect(journalRef?.links[0]?.context).toContain('[[notes/hydra#設計|設計メモ]]');
  });

  it('returns an empty list for a note nobody links to', async () => {
    const res = await fetch(`${server.baseUrl}/api/backlinks?path=notes/isolated.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BacklinksResponse;
    expect(body.backlinks).toEqual([]);
  });

  it('accepts the path without the .md extension (normalized)', async () => {
    const res = await fetch(`${server.baseUrl}/api/backlinks?path=notes/hydra`);
    const body = (await res.json()) as BacklinksResponse;
    expect(body.path).toBe('notes/hydra.md');
    expect(body.backlinks.length).toBeGreaterThan(0);
  });

  it('rejects a missing path parameter and traversal attempts with 400', async () => {
    expect((await fetch(`${server.baseUrl}/api/backlinks`)).status).toBe(400);
    const esc = await fetch(`${server.baseUrl}/api/backlinks?path=${encodeURIComponent('../escape.md')}`);
    expect(esc.status).toBe(400);
  });
});

describe('[AC-S31ba00-2-2] link resolution: #heading, NFC/NFD, extension omission — no block IDs', () => {
  it('resolves NFD input, #heading form, and extension omission to the same note', async () => {
    const target = encodeURIComponent('ノート/概要.md');
    const res = await fetch(`${server.baseUrl}/api/backlinks?path=${target}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BacklinksResponse;
    const linkers = body.backlinks.find((b) => b.source === 'linkers.md');
    expect(linkers).toBeDefined();
    // NFD 表記・heading 付き・拡張子付きの 3 リンクすべてが同一ノートに解決される
    expect(linkers?.links).toHaveLength(3);
    expect(linkers?.links.map((l) => l.line).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    const headings = linkers?.links.map((l) => l.heading);
    expect(headings).toContain('設計');
  });

  it('resolves an NFD path query to the NFC-normalized target', async () => {
    const nfd = encodeURIComponent('ノート/概要.md'.normalize('NFD'));
    const res = await fetch(`${server.baseUrl}/api/backlinks?path=${nfd}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BacklinksResponse;
    expect(body.path).toBe('ノート/概要.md'.normalize('NFC'));
    expect(body.backlinks.some((b) => b.source === 'linkers.md')).toBe(true);
  });

  it('never writes block IDs or any markup into vault files (pure Markdown)', async () => {
    // バックリンク取得を経ても、全ファイルはユーザーが書いたままのバイト列
    await fetch(`${server.baseUrl}/api/backlinks?path=notes/hydra.md`);
    const files = await readAllNotes(vault);
    for (const [abs, content] of files) {
      expect(content, `${abs} にブロック ID が書き込まれている`).not.toMatch(/\^[a-zA-Z0-9]{4,}/);
      expect(content, `${abs} に id:: が書き込まれている`).not.toMatch(/\bid::/);
      expect(content, `${abs} に ((uuid)) が書き込まれている`).not.toMatch(/\(\([0-9a-f-]{8,}\)\)/);
    }
    // リンク元は SOURCES に書いた文字列と完全一致 (無加工)
    for (const [rel, expected] of Object.entries(SOURCES)) {
      expect(files.get(path.join(vault, rel))).toBe(expected);
    }
  });
});
