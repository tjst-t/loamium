/**
 * Story Sd63ad1-2「デイリージャーナル API」受け入れテスト。
 * scenario-Sd63ad1-2.json を機械的に実行する。実サーバー + 実 HTTP クライアント。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';

let server: TestServer;

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

beforeAll(async () => {
  const vault = await makeTempVault();
  server = await startServer({ vault });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe("[AC-Sd63ad1-2-1] GET /api/journal auto-generates today's journal", () => {
  it('returns today (server-local) and creates journals/YYYY-MM-DD.md when missing', async () => {
    const today = localToday();
    const res = await fetch(`${server.baseUrl}/api/journal`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      path: string;
      content: string;
      created: boolean;
      mtime: number | null;
    };
    expect(body.date).toBe(today);
    expect(body.path).toBe(`journals/${today}.md`);
    expect(body.created).toBe(true);
    // Sa704c3: 実ファイルの mtime を返す (UI の楽観的競合検出の基準値)
    expect(typeof body.mtime).toBe('number');

    // ファイルが実際に自動生成されている (ファイルが正本)
    const abs = path.join(server.vault, 'journals', `${today}.md`);
    expect((await stat(abs)).isFile()).toBe(true);

    // 2 回目は既存を返す (created=false)
    const res2 = await fetch(`${server.baseUrl}/api/journal`);
    const body2 = (await res2.json()) as { created: boolean };
    expect(body2.created).toBe(false);
  });

  it('supports ?date=YYYY-MM-DD and auto-generates that file', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-01-15`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { date: string; path: string; created: boolean };
    expect(body.date).toBe('2026-01-15');
    expect(body.path).toBe('journals/2026-01-15.md');
    expect(body.created).toBe(true);

    const abs = path.join(server.vault, 'journals', '2026-01-15.md');
    expect((await stat(abs)).isFile()).toBe(true);
  });

  it('rejects invalid dates with 400 (format and non-existent calendar day)', async () => {
    for (const bad of ['2026-02-30', '2026/01/01', 'not-a-date', '2026-1-5']) {
      const res = await fetch(
        `${server.baseUrl}/api/journal?date=${encodeURIComponent(bad)}`,
      );
      expect(res.status, `date "${bad}" should be rejected`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_date');
    }
  });

  it('returns parsed frontmatter for a journal that has one', async () => {
    await fetch(`${server.baseUrl}/api/notes/journals/2026-02-01.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '---\nmood: good\n---\n- morning note\n' }),
    });
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-02-01`);
    const body = (await res.json()) as {
      frontmatter: Record<string, unknown> | null;
      body: string;
      created: boolean;
    };
    expect(body.created).toBe(false);
    expect(body.frontmatter).toEqual({ mood: 'good' });
    expect(body.body).toBe('- morning note\n');
  });
});

describe('[AC-Sd63ad1-2-2] POST /api/journal/append', () => {
  it("appends to today's journal (creating it if missing)", async () => {
    const today = localToday();
    const res = await fetch(`${server.baseUrl}/api/journal/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '- 決定: X を採用' }),
    });
    expect(res.status).toBe(200); // today のファイルは前のテストで生成済み
    const body = (await res.json()) as { date: string; path: string };
    expect(body.date).toBe(today);
    expect(body.path).toBe(`journals/${today}.md`);

    const raw = await readFile(path.join(server.vault, 'journals', `${today}.md`), 'utf8');
    expect(raw.endsWith('- 決定: X を採用\n')).toBe(true);
  });

  it('appends to a specified date, auto-creating the file (201)', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '- past log entry', date: '2026-03-10' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { date: string; created: boolean };
    expect(body.date).toBe('2026-03-10');
    expect(body.created).toBe(true);

    // 追記の連続で末尾に積まれる
    const res2 = await fetch(`${server.baseUrl}/api/journal/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '- second entry', date: '2026-03-10' }),
    });
    expect(res2.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/journal?date=2026-03-10`);
    const journal = (await get.json()) as { content: string };
    expect(journal.content).toBe('- past log entry\n- second entry\n');
  });

  it('rejects invalid date / empty content with 400', async () => {
    const badDate = await fetch(`${server.baseUrl}/api/journal/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x', date: '2026-02-30' }),
    });
    expect(badDate.status).toBe(400);

    const emptyContent = await fetch(`${server.baseUrl}/api/journal/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    expect(emptyContent.status).toBe(400);
  });
});
