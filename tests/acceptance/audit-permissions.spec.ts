/**
 * Story Sd63ad1-3「監査ログと権限モード」受け入れテスト。
 * scenario-Sd63ad1-3.json を機械的に実行する。実サーバー + 実 HTTP クライアント。
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

interface AuditLine {
  ts: string;
  op: string;
  path: string;
  mode: string;
  result: string;
  status: number;
}

async function readAuditLog(vault: string): Promise<AuditLine[]> {
  const raw = await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditLine);
}

async function seedNote(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

describe('[AC-Sd63ad1-3-1] audit log records every write API call', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedNote(vault, 'seed.md', 'seed content\n');
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('logs PUT / append / patch / DELETE / journal-append with ts, op, path', async () => {
    const base = server.baseUrl;
    const json = { 'content-type': 'application/json' };

    await fetch(`${base}/api/notes/a.md`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ content: 'hello\n' }),
    });
    await fetch(`${base}/api/notes/a.md/append`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: 'more' }),
    });
    await fetch(`${base}/api/notes/a.md/patch`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ old: 'hello', new: 'hi' }),
    });
    await fetch(`${base}/api/journal/append`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: '- log', date: '2026-05-01' }),
    });
    await fetch(`${base}/api/notes/a.md`, { method: 'DELETE' });

    const lines = await readAuditLog(server.vault);
    const ops = lines.map((l) => [l.op, l.path]);
    expect(ops).toContainEqual(['note.write', 'a.md']);
    expect(ops).toContainEqual(['note.append', 'a.md']);
    expect(ops).toContainEqual(['note.patch', 'a.md']);
    expect(ops).toContainEqual(['journal.append', 'journals/2026-05-01.md']);
    expect(ops).toContainEqual(['note.delete', 'a.md']);

    for (const line of lines) {
      // 時刻・操作・パスが必須 (AC-Sd63ad1-3-1)
      expect(Date.parse(line.ts)).not.toBeNaN();
      expect(line.op.length).toBeGreaterThan(0);
      expect(line.path.length).toBeGreaterThan(0);
      expect(line.mode).toBe('full');
      expect(line.result).toBe('ok');
    }
  });

  it('logs journal auto-generation (GET that writes to disk)', async () => {
    await fetch(`${server.baseUrl}/api/journal?date=2026-05-02`);
    const lines = await readAuditLog(server.vault);
    expect(lines.map((l) => [l.op, l.path])).toContainEqual([
      'journal.create',
      'journals/2026-05-02.md',
    ]);
  });

  it('does not log read-only calls (GET note)', async () => {
    const before = (await readAuditLog(server.vault)).length;
    await fetch(`${server.baseUrl}/api/notes/seed.md`);
    await fetch(`${server.baseUrl}/api/health`);
    const after = (await readAuditLog(server.vault)).length;
    expect(after).toBe(before);
  });
});

describe('[AC-Sd63ad1-3-2] read-only mode rejects all writes with 403', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedNote(vault, 'existing.md', 'original\n');
    server = await startServer({ vault, mode: 'read-only' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('rejects PUT / append / patch / DELETE / journal-append with 403 and leaves files untouched', async () => {
    const base = server.baseUrl;
    const json = { 'content-type': 'application/json' };

    const attempts = [
      fetch(`${base}/api/notes/existing.md`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ content: 'overwrite\n' }),
      }),
      fetch(`${base}/api/notes/existing.md/append`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ content: 'x' }),
      }),
      fetch(`${base}/api/notes/existing.md/patch`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ old: 'original', new: 'patched' }),
      }),
      fetch(`${base}/api/notes/existing.md`, { method: 'DELETE' }),
      fetch(`${base}/api/journal/append`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ content: '- x' }),
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('forbidden');
    }

    const raw = await readFile(path.join(server.vault, 'existing.md'), 'utf8');
    expect(raw).toBe('original\n');
  });

  it('still allows reads (200)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/existing.md`);
    expect(res.status).toBe(200);
  });

  it('GET /api/journal does not auto-create the file in read-only mode', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=2026-06-01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.content).toBe('');
    await expect(
      readFile(path.join(server.vault, 'journals', '2026-06-01.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('records denied write attempts in the audit log', async () => {
    const lines = await readAuditLog(server.vault);
    const denied = lines.filter((l) => l.result === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(5);
    for (const line of denied) {
      expect(line.status).toBe(403);
      expect(line.mode).toBe('read-only');
    }
  });
});

describe('[AC-Sd63ad1-3-2] append-only mode allows only appends', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    await seedNote(vault, 'existing.md', 'original\n');
    server = await startServer({ vault, mode: 'append-only' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('allows note append and journal append', async () => {
    const json = { 'content-type': 'application/json' };
    const append = await fetch(`${server.baseUrl}/api/notes/existing.md/append`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: 'appended line' }),
    });
    expect(append.status).toBe(200);

    const journal = await fetch(`${server.baseUrl}/api/journal/append`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: '- work log', date: '2026-05-03' }),
    });
    expect(journal.status).toBe(201);

    const raw = await readFile(path.join(server.vault, 'existing.md'), 'utf8');
    expect(raw).toBe('original\nappended line\n');
  });

  it('rejects overwrite (PUT), patch, and DELETE with 403', async () => {
    const json = { 'content-type': 'application/json' };
    const put = await fetch(`${server.baseUrl}/api/notes/existing.md`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ content: 'overwrite\n' }),
    });
    expect(put.status).toBe(403);

    const patch = await fetch(`${server.baseUrl}/api/notes/existing.md/patch`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ old: 'original', new: 'patched' }),
    });
    expect(patch.status).toBe(403);

    const del = await fetch(`${server.baseUrl}/api/notes/existing.md`, { method: 'DELETE' });
    expect(del.status).toBe(403);

    const raw = await readFile(path.join(server.vault, 'existing.md'), 'utf8');
    expect(raw).toBe('original\nappended line\n'); // 前テストの append 結果のまま
  });
});
