/**
 * [AC-agent-ui] セッション中の権限変更 API (PUT /api/agent/sessions/{id}/permissions)。
 *
 * full モードでセッションを作成し、PUT permissions で実効権限が変わり、
 * GET 詳細 (effectivePermissions) に反映されることを検証する。
 *
 * pi セッション作成は実 LLM に接続せずとも成功する (prompt を送らなければ HTTP は発生しない)。
 * ここではメッセージ送信を行わず、セッション作成・権限変更・詳細取得のみを検証するため、
 * 実 LLM スタブは不要 (プロバイダ登録は in-memory)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../app.js';
import { VaultIndex } from '../noteIndex.js';
import type { ServerConfig } from '../config.js';

async function makeApp(mode: ServerConfig['mode']): Promise<{
  app: ReturnType<typeof createApp>;
  vaultRoot: string;
}> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-agent-perms-'));
  await mkdir(path.join(vaultRoot, '.loamium'), { recursive: true });
  await writeFile(
    path.join(vaultRoot, '.loamium', 'agent.json'),
    JSON.stringify({ api: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'stub', apiKey: 'k' }),
    'utf8',
  );
  const index = new VaultIndex(vaultRoot);
  await index.build();
  const config: ServerConfig = { vaultRoot, mode, maxUploadBytes: 1024 };
  return { app: createApp(config, index), vaultRoot };
}

describe('[AC-agent-ui] PUT /api/agent/sessions/:id/permissions', () => {
  let vaultRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const made = await makeApp('full');
    app = made.app;
    vaultRoot = made.vaultRoot;
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('full モードでセッション作成 → PUT で実効権限が変わり GET 詳細に反映される', async () => {
    // 作成: read-only プリセットで作成する
    const createRes = await app.request('/api/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'read-only' }),
    });
    expect(createRes.status).toBe(200);
    const { id } = (await createRes.json()) as { id: string };
    expect(typeof id).toBe('string');

    // 作成直後の GET 詳細: read のみ
    const detail1 = await app.request(`/api/agent/sessions/${id}`);
    const d1 = (await detail1.json()) as { effectivePermissions?: string[] };
    expect(new Set(d1.effectivePermissions)).toEqual(new Set(['read']));

    // PUT: notes-rw へ変更 (full モードなのでクランプ恒等)
    const putRes = await app.request(`/api/agent/sessions/${id}/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'notes-rw' }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { effectivePermissions?: string[] };
    expect(new Set(putBody.effectivePermissions)).toEqual(
      new Set(['read', 'journal_append', 'note_create', 'note_edit']),
    );

    // セッション権限ストアに保存されている (再オープンで同じ集合を導出できる)
    const stored = JSON.parse(
      await readFile(path.join(vaultRoot, '.loamium', 'agent-session-perms.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(new Set(stored[id])).toEqual(
      new Set(['read', 'journal_append', 'note_create', 'note_edit']),
    );

    // GET 詳細に反映される
    const detail2 = await app.request(`/api/agent/sessions/${id}`);
    const d2 = (await detail2.json()) as { effectivePermissions?: string[] };
    expect(new Set(d2.effectivePermissions)).toEqual(
      new Set(['read', 'journal_append', 'note_create', 'note_edit']),
    );
  });

  it('無効なセッション ID は 400 を返す', async () => {
    const res = await app.request('/api/agent/sessions/..%2Fevil/permissions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'full' }),
    });
    expect(res.status).toBe(400);
  });

  it('不正な permissions は 400 を返す', async () => {
    const createRes = await app.request('/api/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'read-only' }),
    });
    const { id } = (await createRes.json()) as { id: string };
    const res = await app.request(`/api/agent/sessions/${id}/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['not-a-capability'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('[AC-agent-ui] PUT permissions は read-only モードで 403', () => {
  it('read-only モードでは permissionMiddleware が PUT を弾く', async () => {
    const { app, vaultRoot } = await makeApp('read-only');
    try {
      const res = await app.request('/api/agent/sessions/some-id/permissions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: 'full' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
