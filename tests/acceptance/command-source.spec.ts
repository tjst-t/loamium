/**
 * GET/PUT /api/commands/{id}/source 受け入れテスト。
 *
 * notes API は normalizeVaultPath により .md を強制するため commands/*.yaml の
 * 読み書きができない。source エンドポイントはこの問題を回避する専用 API。
 *
 * テストケース:
 * - GET: 存在する yaml を正しく返す (content + mtime)
 * - GET: 存在しない id → 404
 * - GET: .yml 拡張子のファイルも返す
 * - PUT: 書き込み後に GET で反映を確認
 * - PUT: stale mtime → 409 conflict
 * - PUT: read-only → 403
 * - PUT: append-only → 403
 * - PUT: 新規作成 (存在しない id) → created:true
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { commandSourceResponseSchema, commandSourceWriteResponseSchema } from '@loamium/shared';

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const VALID_COMMAND_YAML = [
  'name: test-command',
  'description: テスト用コマンド',
  'params:',
  '  - name: title',
  '    label: タイトル',
  '    required: true',
  'steps:',
  '  - kind: journal-append',
  '    content: "- [ ] {{title}}"',
].join('\n');

const UPDATED_YAML = VALID_COMMAND_YAML + '\n# updated\n';

/** vault に直接ファイルを書き込む */
async function seedFile(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// ---------------------------------------------------------------------------
// GET /api/commands/{id}/source
// ---------------------------------------------------------------------------

describe('GET /api/commands/{id}/source', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault });
    await seedFile(vault, 'commands/test-cmd.yaml', VALID_COMMAND_YAML);
    await seedFile(vault, 'commands/yml-cmd.yml', 'name: yml-cmd\nsteps:\n  - kind: journal-append\n    content: hello\n');
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('存在する .yaml ファイルの生テキストと mtime を返す (200)', async () => {
    const res = await fetch(`${server.baseUrl}/api/commands/test-cmd/source`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = commandSourceResponseSchema.safeParse(body);
    expect(
      parsed.success,
      `schema validation failed: ${!parsed.success ? JSON.stringify(parsed.error.issues) : ''}`,
    ).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.id).toBe('test-cmd');
    expect(parsed.data.path).toBe('commands/test-cmd.yaml');
    expect(parsed.data.content).toBe(VALID_COMMAND_YAML);
    expect(typeof parsed.data.mtime).toBe('number');
    expect(parsed.data.mtime).toBeGreaterThan(0);
  });

  it('存在しない id → 404', async () => {
    const res = await fetch(`${server.baseUrl}/api/commands/does-not-exist/source`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('.yml 拡張子のファイルも返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/commands/yml-cmd/source`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = commandSourceResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.path).toBe('commands/yml-cmd.yml');
    expect(parsed.data.content).toContain('name: yml-cmd');
  });

  it('不正な id (path traversal) → 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/commands/..%2F..%2Fetc/source`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/commands/{id}/source
// ---------------------------------------------------------------------------

describe('PUT /api/commands/{id}/source (full mode)', () => {
  let server: TestServer;

  beforeAll(async () => {
    const vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
    await seedFile(vault, 'commands/update-me.yaml', VALID_COMMAND_YAML);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(server.vault);
  });

  it('書き込みが成功し、GET で新しい content が返る', async () => {
    // まず現在の mtime を取得
    const getRes = await fetch(`${server.baseUrl}/api/commands/update-me/source`);
    expect(getRes.status).toBe(200);
    const getBody = commandSourceResponseSchema.parse(await getRes.json());
    const currentMtime = getBody.mtime;

    // PUT で更新
    const putRes = await fetch(`${server.baseUrl}/api/commands/update-me/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: UPDATED_YAML, mtime: currentMtime }),
    });
    expect(putRes.status).toBe(200);
    const putBody: unknown = await putRes.json();
    const parsed = commandSourceWriteResponseSchema.safeParse(putBody);
    expect(
      parsed.success,
      `schema validation failed: ${!parsed.success ? JSON.stringify(parsed.error.issues) : ''}`,
    ).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.id).toBe('update-me');
    expect(parsed.data.path).toBe('commands/update-me.yaml');
    expect(parsed.data.created).toBe(false);
    expect(typeof parsed.data.mtime).toBe('number');

    // GET で反映を確認
    const verifyRes = await fetch(`${server.baseUrl}/api/commands/update-me/source`);
    expect(verifyRes.status).toBe(200);
    const verifyBody = commandSourceResponseSchema.parse(await verifyRes.json());
    expect(verifyBody.content).toBe(UPDATED_YAML);
  });

  it('mtime 省略時は無条件上書き (last-write-wins)', async () => {
    const putRes = await fetch(`${server.baseUrl}/api/commands/update-me/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: VALID_COMMAND_YAML }),
    });
    expect(putRes.status).toBe(200);
    const body = commandSourceWriteResponseSchema.parse(await putRes.json());
    expect(body.created).toBe(false);
  });

  it('stale mtime → 409 conflict', async () => {
    const staleMtime = 1; // 過去の mtime
    const putRes = await fetch(`${server.baseUrl}/api/commands/update-me/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: UPDATED_YAML, mtime: staleMtime }),
    });
    expect(putRes.status).toBe(409);
    const body = (await putRes.json()) as { error: string };
    expect(body.error).toBe('conflict');
  });

  it('存在しない id を PUT すると新規作成 (created:true)', async () => {
    const putRes = await fetch(`${server.baseUrl}/api/commands/brand-new/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: VALID_COMMAND_YAML }),
    });
    expect(putRes.status).toBe(200);
    const body = commandSourceWriteResponseSchema.parse(await putRes.json());
    expect(body.created).toBe(true);
    expect(body.path).toBe('commands/brand-new.yaml');

    // GET で取得できる
    const getRes = await fetch(`${server.baseUrl}/api/commands/brand-new/source`);
    expect(getRes.status).toBe(200);
    const getBody = commandSourceResponseSchema.parse(await getRes.json());
    expect(getBody.content).toBe(VALID_COMMAND_YAML);
  });
});

// ---------------------------------------------------------------------------
// 権限モード
// ---------------------------------------------------------------------------

describe('PUT /api/commands/{id}/source — 権限モード', () => {
  it('read-only モード → PUT は 403', async () => {
    const vault = await makeTempVault();
    const server = await startServer({ vault, mode: 'read-only' });
    try {
      await seedFile(vault, 'commands/test.yaml', VALID_COMMAND_YAML);
      const res = await fetch(`${server.baseUrl}/api/commands/test/source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: UPDATED_YAML }),
      });
      // read-only モードでは permissionMiddleware が 403 を返す
      expect(res.status).toBe(403);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('append-only モード → PUT は 403', async () => {
    const vault = await makeTempVault();
    const server = await startServer({ vault, mode: 'append-only' });
    try {
      await seedFile(vault, 'commands/test.yaml', VALID_COMMAND_YAML);
      const res = await fetch(`${server.baseUrl}/api/commands/test/source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: UPDATED_YAML }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('forbidden');
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('append-only モード → GET は許可 (200)', async () => {
    const vault = await makeTempVault();
    const server = await startServer({ vault, mode: 'append-only' });
    try {
      await seedFile(vault, 'commands/test.yaml', VALID_COMMAND_YAML);
      const res = await fetch(`${server.baseUrl}/api/commands/test/source`);
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });
});
