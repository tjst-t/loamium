/**
 * Story Sd63ad1-1「ノート読み書き API」受け入れテスト。
 * scenario-Sd63ad1-1.json を機械的に実行する。実サーバー + 実 HTTP クライアント。
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

beforeAll(async () => {
  const vault = await makeTempVault();
  server = await startServer({ vault });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-Sd63ad1-1-1] PUT/GET notes (create, read with frontmatter, overwrite)', () => {
  it('creates a note with PUT and reads it back with parsed frontmatter', async () => {
    const content = '---\ntitle: Loamium\ntags:\n  - project\n---\n# Loamium\n\nメモ本文。\n';
    const put = await fetch(`${server.baseUrl}/api/notes/projects/loamium.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    expect(put.status).toBe(201);
    const putBody = (await put.json()) as { path: string; created: boolean };
    expect(putBody).toEqual({ path: 'projects/loamium.md', created: true });

    // vault 上に実ファイルが作られている (ファイルが正本)
    const abs = path.join(server.vault, 'projects/loamium.md');
    expect((await stat(abs)).isFile()).toBe(true);

    const get = await fetch(`${server.baseUrl}/api/notes/projects/loamium.md`);
    expect(get.status).toBe(200);
    const note = (await get.json()) as {
      path: string;
      content: string;
      frontmatter: Record<string, unknown> | null;
      body: string;
    };
    expect(note.path).toBe('projects/loamium.md');
    expect(note.content).toBe(content);
    expect(note.frontmatter).toEqual({ title: 'Loamium', tags: ['project'] });
    expect(note.body).toBe('# Loamium\n\nメモ本文。\n');
  });

  it('overwrites an existing note with PUT (200, created=false)', async () => {
    const put = await fetch(`${server.baseUrl}/api/notes/projects/loamium.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'overwritten\n' }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { created: boolean };
    expect(putBody.created).toBe(false);

    const get = await fetch(`${server.baseUrl}/api/notes/projects/loamium.md`);
    const note = (await get.json()) as { content: string; frontmatter: unknown };
    expect(note.content).toBe('overwritten\n');
    expect(note.frontmatter).toBeNull();
  });

  it('adds .md automatically when the path has no extension', async () => {
    const put = await fetch(`${server.baseUrl}/api/notes/inbox/quick`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'quick note\n' }),
    });
    expect(put.status).toBe(201);
    const putBody = (await put.json()) as { path: string };
    expect(putBody.path).toBe('inbox/quick.md');

    const get = await fetch(`${server.baseUrl}/api/notes/inbox/quick.md`);
    expect(get.status).toBe(200);
  });

  it('returns 404 for a missing note', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/nope/missing.md`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('handles Japanese (NFC-normalized) paths', async () => {
    const nfdPath =
      encodeURIComponent('日記') + '/' + encodeURIComponent('がき'.normalize('NFD')); // NFD 濁点
    const put = await fetch(`${server.baseUrl}/api/notes/${nfdPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'にほんご\n' }),
    });
    expect(put.status).toBe(201);
    const putBody = (await put.json()) as { path: string };
    expect(putBody.path).toBe('日記/がき.md'.normalize('NFC')); // NFC に正規化されている

    const nfcPath =
      encodeURIComponent('日記') + '/' + encodeURIComponent('がき'.normalize('NFC'));
    const get = await fetch(`${server.baseUrl}/api/notes/${nfcPath}`);
    expect(get.status).toBe(200);
  });
});

describe('[AC-Sd63ad1-1-2] append and patch', () => {
  it('appends to the end of a note', async () => {
    await fetch(`${server.baseUrl}/api/notes/notes/todo.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# TODO\n\n- [ ] first\n' }),
    });

    const append = await fetch(`${server.baseUrl}/api/notes/notes/todo.md/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '- [ ] new task' }),
    });
    expect(append.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/notes/notes/todo.md`);
    const note = (await get.json()) as { content: string };
    expect(note.content).toBe('# TODO\n\n- [ ] first\n- [ ] new task\n');
  });

  it('patches old→new (single occurrence)', async () => {
    const patch = await fetch(`${server.baseUrl}/api/notes/notes/todo.md/patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old: '- [ ] first', new: '- [x] first' }),
    });
    expect(patch.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/notes/notes/todo.md`);
    const note = (await get.json()) as { content: string };
    expect(note.content).toBe('# TODO\n\n- [x] first\n- [ ] new task\n');
  });

  it('returns 409 when old is not found, without modifying the file', async () => {
    const before = await readFile(path.join(server.vault, 'notes/todo.md'), 'utf8');
    const patch = await fetch(`${server.baseUrl}/api/notes/notes/todo.md/patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old: 'does not exist anywhere', new: 'x' }),
    });
    expect(patch.status).toBe(409);
    const body = (await patch.json()) as { error: string };
    expect(body.error).toBe('old_not_found');
    const after = await readFile(path.join(server.vault, 'notes/todo.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('returns 409 when old matches multiple locations (ambiguous, data safety)', async () => {
    await fetch(`${server.baseUrl}/api/notes/notes/dup.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'same\nsame\n' }),
    });
    const patch = await fetch(`${server.baseUrl}/api/notes/notes/dup.md/patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old: 'same', new: 'diff' }),
    });
    expect(patch.status).toBe(409);
    const body = (await patch.json()) as { error: string };
    expect(body.error).toBe('ambiguous_match');
  });

  it('returns 404 when appending to a missing note', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/ghost.md/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid request body with 400 (zod validation)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/notes/todo.md/patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old: '' }), // old 空 + new 欠落
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });
});

describe('[AC-Sd63ad1-1-3] path traversal rejection and UTF-8/LF storage', () => {
  it('rejects ../ traversal with 400 and writes nothing outside the vault', async () => {
    // fetch は URL 正規化で ../ を潰すため、エンコード済みで送る
    const res = await fetch(`${server.baseUrl}/api/notes/..%2Fescape.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'evil\n' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_path');

    // vault の親ディレクトリに escape.md が作られていない
    await expect(stat(path.join(server.vault, '..', 'escape.md'))).rejects.toThrow();
  });

  it('rejects nested traversal and hidden segments (.loamium protection)', async () => {
    for (const p of ['a%2F..%2F..%2Fb.md', '.loamium%2Faudit.log', '.git%2Fconfig']) {
      const res = await fetch(`${server.baseUrl}/api/notes/${p}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'evil\n' }),
      });
      expect(res.status, `path ${p} should be rejected`).toBe(400);
    }
  });

  it('stores files as UTF-8 with LF only (CRLF input is normalized)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/crlf.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'line1\r\nline2\r\n日本語も\r\n' }),
    });
    expect(res.status).toBe(201);

    const raw = await readFile(path.join(server.vault, 'crlf.md'));
    const text = raw.toString('utf8');
    expect(text.includes('\r')).toBe(false);
    expect(text).toBe('line1\nline2\n日本語も\n');
    // UTF-8 として往復可能 (バイト列が UTF-8 で解釈できる)
    expect(Buffer.from(text, 'utf8').equals(raw)).toBe(true);
  });
});

describe('health endpoint', () => {
  it('GET /api/health returns ok with the permission mode', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mode: string };
    expect(body).toEqual({ status: 'ok', mode: 'full' });
  });
});

describe('DELETE /api/notes/{path}', () => {
  it('deletes an existing note and returns 404 afterwards', async () => {
    await fetch(`${server.baseUrl}/api/notes/tmp/delete-me.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'bye\n' }),
    });
    const del = await fetch(`${server.baseUrl}/api/notes/tmp/delete-me.md`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    const get = await fetch(`${server.baseUrl}/api/notes/tmp/delete-me.md`);
    expect(get.status).toBe(404);

    const delAgain = await fetch(`${server.baseUrl}/api/notes/tmp/delete-me.md`, {
      method: 'DELETE',
    });
    expect(delAgain.status).toBe(404);
  });
});
