/**
 * [AC-S5bd678-1-3] ケーパビリティ権限モデル — セッション権限の永続化 + 再起動復元 (ADR-0011)。
 *
 * - POST /api/agent/sessions が permissions (optional) を受理しセッションに永続化する。
 * - GET /api/agent/sessions/{id} が effectivePermissions (有効ケーパビリティ配列) を返す。
 * - 再オープン (サーバー再起動 = active キャッシュ空) 後も、ディスクの
 *   agent-session-perms.json から同じケーパビリティ集合が復元される。
 * - 実効権限 = 権限 ∩ LOAMIUM_MODE (サーバー側クランプ)。
 *
 * LLM は呼ばない (セッション作成 / GET 詳細のみ)。agent.json は到達不能な baseUrl を指す。
 * 実サーバー 2 プロセス (起動→作成→停止→再起動→GET) + 実 HTTP。モックで実機を偽装しない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

const UNREACHABLE_AGENT_CONFIG = JSON.stringify({
  api: 'openai',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'stub-model',
  apiKey: 'stub-key',
});

async function writeAgentConfig(vault: string, extra?: Record<string, unknown>): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  const base = JSON.parse(UNREACHABLE_AGENT_CONFIG) as Record<string, unknown>;
  await writeFile(
    path.join(dir, 'agent.json'),
    JSON.stringify({ ...base, ...(extra ?? {}) }),
    'utf8',
  );
}

type DetailResponse = {
  id: string;
  effectivePermissions?: string[];
};

async function createSession(baseUrl: string, permissions?: unknown): Promise<string> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  };
  if (permissions !== undefined) {
    init.body = JSON.stringify({ permissions });
  }
  const res = await fetch(`${baseUrl}/api/agent/sessions`, init);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(id).toBeTruthy();
  return id;
}

async function getDetail(baseUrl: string, id: string): Promise<DetailResponse> {
  const res = await fetch(`${baseUrl}/api/agent/sessions/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DetailResponse;
}

let vault: string | null = null;
let running: TestServer | null = null;

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
  if (vault) {
    await cleanupVault(vault);
    vault = null;
  }
});

describe('[AC-S5bd678-1-3] agent capability permissions', () => {
  it('permissions 未指定は read-only 既定 (read のみ) を返す', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const server = await startServer({ vault, mode: 'full' });
    running = server;

    const id = await createSession(server.baseUrl);
    const detail = await getDetail(server.baseUrl, id);
    expect(detail.effectivePermissions).toEqual(['read']);
  });

  it('プリセット notes-rw を受理し effectivePermissions に反映する (mode=full)', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const server = await startServer({ vault, mode: 'full' });
    running = server;

    const id = await createSession(server.baseUrl, 'notes-rw');
    const detail = await getDetail(server.baseUrl, id);
    expect(detail.effectivePermissions).toEqual([
      'read',
      'journal_append',
      'note_create',
      'note_edit',
    ]);
  });

  it('ケーパビリティ配列を受理する', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const server = await startServer({ vault, mode: 'full' });
    running = server;

    const id = await createSession(server.baseUrl, ['read', 'note_edit']);
    const detail = await getDetail(server.baseUrl, id);
    expect(detail.effectivePermissions).toEqual(['read', 'note_edit']);
  });

  it('実効権限 = 権限 ∩ LOAMIUM_MODE: read-only モードは書き込みを落とす', async () => {
    // NOTE: POST /api/agent/sessions は read-only モードでは permissionMiddleware に
    // より 403 になる (mutate 分類、既存挙動)。よって full で作成 → read-only で再起動し
    // GET のクランプ結果を検証する (GET は read 分類でモードを問わず通る)。
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const serverA = await startServer({ vault, mode: 'full' });
    const id = await createSession(serverA.baseUrl, 'full');
    await serverA.stop();

    const serverB = await startServer({ vault, mode: 'read-only' });
    running = serverB;
    const detail = await getDetail(serverB.baseUrl, id);
    // read-only クランプ表: {read, web} のみ残す (web はケーパビリティとして残る)。
    expect(detail.effectivePermissions).toEqual(['read', 'web']);
  });

  it('append-only モードは journal_append まで残す', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const serverA = await startServer({ vault, mode: 'full' });
    const id = await createSession(serverA.baseUrl, 'full');
    await serverA.stop();

    const serverB = await startServer({ vault, mode: 'append-only' });
    running = serverB;
    const detail = await getDetail(serverB.baseUrl, id);
    expect(detail.effectivePermissions).toEqual(['read', 'journal_append', 'web']);
  });

  it('再起動 (active キャッシュ空) 後もディスクからセッション権限が復元される', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);

    // --- プロセス A: notes-rw で作成 ---
    const serverA = await startServer({ vault, mode: 'full' });
    const id = await createSession(serverA.baseUrl, 'notes-rw');
    // 作成直後 (active キャッシュ経由) の GET も同じ集合を返す
    const detailA = await getDetail(serverA.baseUrl, id);
    expect(detailA.effectivePermissions).toEqual([
      'read',
      'journal_append',
      'note_create',
      'note_edit',
    ]);
    await serverA.stop();

    // --- プロセス B: 再起動 (active キャッシュは空) → GET でディスク復元 ---
    const serverB = await startServer({ vault, mode: 'full' });
    running = serverB;
    const detailB = await getDetail(serverB.baseUrl, id);
    // agent-session-perms.json から復元され、作成時と同じ集合になること。
    expect(detailB.effectivePermissions).toEqual([
      'read',
      'journal_append',
      'note_create',
      'note_edit',
    ]);
  });

  it('不正な permissions は 400 を返す', async () => {
    vault = await makeTempVault();
    await writeAgentConfig(vault);
    const server = await startServer({ vault, mode: 'full' });
    running = server;

    const res = await fetch(`${server.baseUrl}/api/agent/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'super-admin' }),
    });
    expect(res.status).toBe(400);
  });
});
