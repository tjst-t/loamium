/**
 * S31ba00-1 全文検索とノート一覧 — 受け入れテスト。
 * 実サーバー (tsx サブプロセス) を実 HTTP クライアントで叩く (test-discipline Rule 2: api)。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

interface SearchResponse {
  query: string;
  results: { path: string; title: string; score: number; snippet: string; line: number | null }[];
}
interface NoteListResponse {
  notes: { path: string; title: string; tags: string[]; folder: string }[];
}
interface TagsResponse {
  tags: { tag: string; count: number }[];
}

let server: TestServer;
let vault: string;

beforeAll(async () => {
  vault = await makeTempVault();
  // 起動前にファイルを直接配置 → 起動時全走査 (build) の検証を兼ねる
  await mkdir(path.join(vault, 'projects'), { recursive: true });
  await mkdir(path.join(vault, 'notes'), { recursive: true });
  await writeFile(
    path.join(vault, 'projects/hydra.md'),
    '# Hydra\n\nHydra の監査ログ設計について。 #dev #audit\n',
    'utf8',
  );
  await writeFile(
    path.join(vault, 'projects/loamium.md'),
    '---\ntags: [dev, note-app]\n---\n\nLoamium はピュア Markdown のノートアプリ。\n',
    'utf8',
  );
  await writeFile(
    path.join(vault, 'notes/fenced.md'),
    'コードの説明。\n\n```sh\necho "#fake タグではない"\n```\n',
    'utf8',
  );
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(vault);
});

describe('[AC-S31ba00-1-1] GET /api/search full-text search', () => {
  it('finds a note by a body keyword and returns path + matching snippet', async () => {
    const res = await fetch(`${server.baseUrl}/api/search?q=${encodeURIComponent('監査ログ')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.query).toBe('監査ログ');
    const hit = body.results.find((r) => r.path === 'projects/hydra.md');
    expect(hit).toBeDefined();
    expect(hit?.snippet).toContain('監査ログ');
    expect(hit?.line).toBe(3);
  });

  it('reflects notes created through the API immediately (write-through index)', async () => {
    const put = await fetch(`${server.baseUrl}/api/notes/notes/zebra.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '固有語シマウマメモ zebraword\n' }),
    });
    expect(put.status).toBe(201);
    const res = await fetch(`${server.baseUrl}/api/search?q=zebraword`);
    const body = (await res.json()) as SearchResponse;
    expect(body.results.map((r) => r.path)).toContain('notes/zebra.md');
    expect(body.results[0]?.snippet).toContain('zebraword');
  });

  it('returns an empty result list for a query that matches nothing', async () => {
    const res = await fetch(`${server.baseUrl}/api/search?q=zzzzqqqqxxxxwwww`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.results).toEqual([]);
  });

  it('rejects a missing/empty q parameter with 400', async () => {
    const noQ = await fetch(`${server.baseUrl}/api/search`);
    expect(noQ.status).toBe(400);
    const emptyQ = await fetch(`${server.baseUrl}/api/search?q=%20`);
    expect(emptyQ.status).toBe(400);
  });
});

describe('[AC-S31ba00-1-2] GET /api/notes list with tag / folder filters', () => {
  it('lists all vault notes without filters', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as NoteListResponse;
    const paths = body.notes.map((n) => n.path);
    expect(paths).toContain('projects/hydra.md');
    expect(paths).toContain('projects/loamium.md');
    expect(paths).toContain('notes/fenced.md');
  });

  it('filters by tag, recognizing both inline #tag and frontmatter tags', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes?tag=dev`);
    const body = (await res.json()) as NoteListResponse;
    const paths = body.notes.map((n) => n.path);
    // projects/hydra.md は本文の #dev、projects/loamium.md は frontmatter tags: [dev]
    expect(paths).toContain('projects/hydra.md');
    expect(paths).toContain('projects/loamium.md');
    expect(paths).not.toContain('notes/fenced.md');
  });

  it('accepts the tag filter with a leading #', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes?tag=${encodeURIComponent('#audit')}`);
    const body = (await res.json()) as NoteListResponse;
    expect(body.notes.map((n) => n.path)).toEqual(['projects/hydra.md']);
  });

  it('does not recognize #tags inside fenced code blocks', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes?tag=fake`);
    const body = (await res.json()) as NoteListResponse;
    expect(body.notes).toEqual([]);
  });

  it('filters by folder (subfolders included)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes?folder=projects`);
    const body = (await res.json()) as NoteListResponse;
    const paths = body.notes.map((n) => n.path);
    expect(paths).toContain('projects/hydra.md');
    expect(paths).toContain('projects/loamium.md');
    expect(paths.every((p) => p.startsWith('projects/'))).toBe(true);
  });

  it('combines tag and folder filters', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes?tag=audit&folder=projects`);
    const body = (await res.json()) as NoteListResponse;
    expect(body.notes.map((n) => n.path)).toEqual(['projects/hydra.md']);
    const none = await fetch(`${server.baseUrl}/api/notes?tag=audit&folder=notes`);
    const noneBody = (await none.json()) as NoteListResponse;
    expect(noneBody.notes).toEqual([]);
  });

  it('GET /api/tags returns vault-wide tags with counts', async () => {
    const res = await fetch(`${server.baseUrl}/api/tags`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TagsResponse;
    const dev = body.tags.find((t) => t.tag === 'dev');
    expect(dev?.count).toBe(2); // hydra (#dev インライン) + loamium (frontmatter)
    expect(body.tags.map((t) => t.tag)).toContain('audit');
    expect(body.tags.map((t) => t.tag)).not.toContain('fake');
  });
});
