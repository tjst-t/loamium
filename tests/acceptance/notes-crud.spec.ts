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
    const putBody = (await put.json()) as { path: string; created: boolean; mtime: number };
    expect(putBody).toEqual({
      path: 'projects/loamium.md',
      created: true,
      // Sa704c3: 書き込み後の mtime (ms epoch) — UI の楽観的競合検出の基準値
      mtime: expect.any(Number),
    });
    expect(Number.isInteger(putBody.mtime)).toBe(true);

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
      mtime: number;
    };
    expect(note.path).toBe('projects/loamium.md');
    expect(note.content).toBe(content);
    expect(note.frontmatter).toEqual({ title: 'Loamium', tags: ['project'] });
    expect(note.body).toBe('# Loamium\n\nメモ本文。\n');
    // GET はファイルの実 mtime を返す (Sa704c3: 保存時の baseMtime に使う)
    const fileMtime = Math.trunc((await stat(abs)).mtimeMs);
    expect(note.mtime).toBe(fileMtime);
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
    // Sa704c3: append レスポンスも書き込み後 mtime を返す (UI の baseMtime 更新用)
    const appendBody = (await append.json()) as { mtime: number };
    expect(Number.isInteger(appendBody.mtime)).toBe(true);

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

  it('does not interpret $-patterns in the replacement string (data safety)', async () => {
    await fetch(`${server.baseUrl}/api/notes/notes/dollar.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'price: TBD\n' }),
    });
    const patch = await fetch(`${server.baseUrl}/api/notes/notes/dollar.md/patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old: 'TBD', new: "$& $' $$100" }),
    });
    expect(patch.status).toBe(200);
    const get = await fetch(`${server.baseUrl}/api/notes/notes/dollar.md`);
    const note = (await get.json()) as { content: string };
    expect(note.content).toBe("price: $& $' $$100\n"); // 文字通り置換される
  });

  it('rejects an action call without a note path (POST /api/notes/append) with 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(400);
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
  it('GET /api/health returns ok with the permission mode and terminal flag', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mode: string };
    // terminal は Sb7f458 の additive 拡張 (このハーネスは LOAMIUM_TERMINAL 未設定なので無効)
    expect(body).toEqual({
      status: 'ok',
      mode: 'full',
      terminal: { enabled: false, reason: 'terminal_env_not_set' },
    });
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

/**
 * Sa704c3: mtime ベースの楽観的競合検出 (SPEC §9 高-1 / ARCHITECTURE 既定路線)。
 * PUT に baseMtime を渡すと、ファイルの現 mtime と不一致な場合 409 conflict になり
 * ファイルは上書きされない (データ安全性 priority 2)。
 */
describe('PUT /api/notes/{path} — mtime 楽観的競合検出 (Sa704c3)', () => {
  it('returns 409 conflict and keeps the file intact when baseMtime is stale', async () => {
    // 1. ノートを作成し、その時点の mtime を得る
    const put1 = await fetch(`${server.baseUrl}/api/notes/conflict/target.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'v1\n' }),
    });
    expect(put1.status).toBe(201);
    const { mtime: baseMtime } = (await put1.json()) as { mtime: number };

    // 2. 別プロセス相当の書き込みで mtime を進める (mtime の解像度対策で待つ)
    await new Promise((r) => setTimeout(r, 20));
    const put2 = await fetch(`${server.baseUrl}/api/notes/conflict/target.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'v2 (external)\n' }),
    });
    expect(put2.status).toBe(200);

    // 3. 古い baseMtime で保存すると 409、ファイルは v2 のまま
    const conflicted = await fetch(`${server.baseUrl}/api/notes/conflict/target.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'v3 (stale editor)\n', baseMtime }),
    });
    expect(conflicted.status).toBe(409);
    const err = (await conflicted.json()) as { error: string };
    expect(err.error).toBe('conflict');
    const abs = path.join(server.vault, 'conflict/target.md');
    expect(await readFile(abs, 'utf8')).toBe('v2 (external)\n');
  });

  it('succeeds when baseMtime matches the current file mtime', async () => {
    const put1 = await fetch(`${server.baseUrl}/api/notes/conflict/ok.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'v1\n' }),
    });
    const { mtime } = (await put1.json()) as { mtime: number };

    const put2 = await fetch(`${server.baseUrl}/api/notes/conflict/ok.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'v2\n', baseMtime: mtime }),
    });
    expect(put2.status).toBe(200);
    const body = (await put2.json()) as { created: boolean; mtime: number };
    expect(body.created).toBe(false);
    expect(body.mtime).toBeGreaterThanOrEqual(mtime);
    const abs = path.join(server.vault, 'conflict/ok.md');
    expect(await readFile(abs, 'utf8')).toBe('v2\n');
  });

  it('creates the note when baseMtime is given but the file no longer exists (non-destructive)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/conflict/recreated.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'restored\n', baseMtime: 12345 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean };
    expect(body.created).toBe(true);
  });
});
