/**
 * 設定 API 受け入れテスト (Sa10026-5)
 *
 * [AC-Sa10026-5-1] 4 群 zod 検証付き read/write (settings.yaml / agent 接続・権限・privacy)
 * [AC-Sa10026-5-2] 書き込み系 → 監査ログ + LOAMIUM_MODE クランプ
 * [AC-Sa10026-5-4] connection/test + models (fallback 含む)
 *
 * テスト設計:
 *   - 実サーバー + 実 HTTP クライアント (ハンドラ直接呼び出しなし)
 *   - connection/test の成功系 → 小さなローカル HTTP スタブサーバーを使う
 *   - connection/test の失敗系 → 無効 URL を渡して ok:false を検証
 *   - apiKey 実値はどのレスポンスにも含まれないことを検証
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';

// ---- helpers ----------------------------------------------------------------

async function seedAgentJson(vault: string, content: Record<string, unknown>): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent.json'), JSON.stringify(content), 'utf8');
}

async function readAuditLog(vault: string): Promise<Array<{ op: string; path: string; result: string; mode: string }>> {
  try {
    const raw = await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { op: string; path: string; result: string; mode: string });
  } catch {
    return [];
  }
}

/** テスト用ローカル HTTP スタブサーバーを起動する。 */
function startStubServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({
        port: addr.port,
        stop: () => new Promise<void>((res2, rej2) => srv.close((err) => err ? rej2(err) : res2())),
      });
    });
  });
}

// ---- テスト本体 -------------------------------------------------------------

let server: TestServer;
let vault: string;

afterEach(async () => {
  await server.stop();
  await cleanupVault(vault);
});

// ==========================================================================
// [AC-Sa10026-5-1] Group 1: system settings (system/settings.yaml)
// ==========================================================================

describe('[AC-Sa10026-5-1] system settings (GET/PUT /api/settings/system)', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('GET returns default settings when settings.yaml does not exist', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/system`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, unknown> };
    // 統合後: 不在時は appSettingsSchema の既定値を返す (system-definitions.ts / Sa10026-3)
    expect(body.settings).toEqual({
      theme: 'system',
      defaultFolder: '',
      journalTemplate: 'system/templates/journal.md',
      showSystemFolder: false,
    });
  });

  it('PUT saves settings and GET reads them back', async () => {
    const settings = { theme: 'dark', locale: 'ja' };
    const put = await fetch(`${server.baseUrl}/api/settings/system`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/settings/system`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.theme).toBe('dark');
    expect(body.settings.locale).toBe('ja');
  });

  it('PUT with invalid body returns 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/system`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

// ==========================================================================
// [AC-Sa10026-5-1] Group 2: agent connection (agent.json)
// ==========================================================================

describe('[AC-Sa10026-5-1] agent connection settings (GET/PUT /api/settings/agent/connection)', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('GET returns null when agent.json does not exist', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: null };
    expect(body.connection).toBeNull();
  });

  it('GET returns masked apiKey (not the actual value) and hasApiKey:true', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-4o',
      apiKey: 'sk-realkey-never-show',
    });
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: { api: string; baseUrl: string; model: string; apiKeyRef: string; hasApiKey?: boolean };
    };
    expect(body.connection).not.toBeNull();
    expect(body.connection.apiKeyRef).toBe('(set)'); // 実値は返さない
    expect(body.connection.hasApiKey).toBe(true); // キー設定済みを示すフラグ
    expect(JSON.stringify(body)).not.toContain('sk-realkey-never-show');
  });

  it('GET returns $ENV_VAR ref as-is (not the resolved value)', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-4o',
      apiKey: '$MY_API_KEY',
    });
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection`);
    const body = (await res.json()) as { connection: { apiKeyRef: string } };
    expect(body.connection.apiKeyRef).toBe('$MY_API_KEY');
  });

  it('PUT saves connection and GET reads back (apiKey as $ENV ref)', async () => {
    const put = await fetch(`${server.baseUrl}/api/settings/agent/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-haiku-20241022',
        apiKey: '$ANTHROPIC_API_KEY',
      }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/settings/agent/connection`);
    const body = (await get.json()) as {
      connection: { api: string; baseUrl: string; model: string; apiKeyRef: string };
    };
    expect(body.connection.api).toBe('anthropic');
    expect(body.connection.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(body.connection.model).toBe('claude-3-5-haiku-20241022');
    expect(body.connection.apiKeyRef).toBe('$ANTHROPIC_API_KEY');
  });

  it('PUT preserves existing permissions when updating connection', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://old/v1',
      model: 'old-model',
      apiKey: '$OLD_KEY',
      permissions: 'notes-rw',
    });

    await fetch(`${server.baseUrl}/api/settings/agent/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai',
        baseUrl: 'http://new/v1',
        model: 'new-model',
        apiKey: '$NEW_KEY',
      }),
    });

    // agent.json を直接読んで permissions が残っているか確認
    const raw = await readFile(path.join(vault, '.loamium', 'agent.json'), 'utf8');
    const json = JSON.parse(raw) as { permissions: unknown };
    expect(json.permissions).toBe('notes-rw');
  });

  it('PUT without apiKey preserves existing apiKey (直値上書き防止)', async () => {
    // 既存キーを設定
    await seedAgentJson(vault, {
      api: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-existing-real-key',
    });

    // apiKey を省略して PUT (UI が保存済みキーを変更しない場合の想定動作)
    const put = await fetch(`${server.baseUrl}/api/settings/agent/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-opus-4-8',
        // apiKey は省略 → 既存キーを維持する
      }),
    });
    expect(put.status).toBe(200);

    // agent.json を直接読んで apiKey が維持されているか確認
    const raw = await readFile(path.join(vault, '.loamium', 'agent.json'), 'utf8');
    const json = JSON.parse(raw) as { apiKey: string; model: string };
    expect(json.apiKey).toBe('sk-existing-real-key'); // 既存キーが維持される
    expect(json.model).toBe('claude-opus-4-8'); // モデルは更新される
  });
});

// ==========================================================================
// [AC-Sa10026-5-1] Group 3: agent permissions
// ==========================================================================

describe('[AC-Sa10026-5-1] agent permissions (GET/PUT /api/settings/agent/permissions)', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('GET returns null when agent.json does not exist', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/permissions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: null };
    expect(body.permissions).toBeNull();
  });

  it('GET returns effective permissions clamped by mode', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://x/v1',
      model: 'x',
      apiKey: '$X',
      permissions: 'full',
    });
    // mode=full で起動しているのでクランプなし
    const res = await fetch(`${server.baseUrl}/api/settings/agent/permissions`);
    const body = (await res.json()) as {
      permissions: { value: unknown; effective: string[] };
    };
    expect(body.permissions.value).toBe('full');
    expect(body.permissions.effective).toContain('read');
    expect(body.permissions.effective).toContain('note_edit');
  });

  it('PUT saves permissions preset and GET reflects', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://x/v1',
      model: 'x',
      apiKey: '$X',
    });

    const put = await fetch(`${server.baseUrl}/api/settings/agent/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'notes-rw' }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/settings/agent/permissions`);
    const body = (await get.json()) as { permissions: { value: unknown; effective: string[] } };
    expect(body.permissions.value).toBe('notes-rw');
    expect(body.permissions.effective).toContain('journal_append');
  });

  it('PUT saves capability array', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://x/v1',
      model: 'x',
      apiKey: '$X',
    });

    await fetch(`${server.baseUrl}/api/settings/agent/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['read', 'note_edit'] }),
    });

    const get = await fetch(`${server.baseUrl}/api/settings/agent/permissions`);
    const body = (await get.json()) as { permissions: { effective: string[] } };
    expect(body.permissions.effective).toContain('read');
    expect(body.permissions.effective).toContain('note_edit');
    expect(body.permissions.effective).not.toContain('note_create');
  });

  it('PUT with invalid preset returns 400', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://x/v1',
      model: 'x',
      apiKey: '$X',
    });

    const res = await fetch(`${server.baseUrl}/api/settings/agent/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'super-admin' }),
    });
    expect(res.status).toBe(400);
  });
});

// ==========================================================================
// [AC-Sa10026-5-1] Group 4: privacy deny-list
// ==========================================================================

describe('[AC-Sa10026-5-1] privacy deny-list (GET/PUT /api/settings/agent/privacy)', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('GET returns empty array when agent-privacy.json does not exist', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/privacy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deny: string[] };
    expect(body.deny).toEqual([]);
  });

  it('PUT saves deny list and GET reads back', async () => {
    const put = await fetch(`${server.baseUrl}/api/settings/agent/privacy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deny: ['private/**', 'secret.md'] }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${server.baseUrl}/api/settings/agent/privacy`);
    const body = (await get.json()) as { deny: string[] };
    expect(body.deny).toEqual(['private/**', 'secret.md']);

    // ファイルが {deny:[...]} 形式で保存されているか確認
    const raw = await readFile(path.join(vault, '.loamium', 'agent-privacy.json'), 'utf8');
    const json = JSON.parse(raw) as { deny: string[] };
    expect(json.deny).toEqual(['private/**', 'secret.md']);
  });
});

// ==========================================================================
// [AC-Sa10026-5-2] 監査ログ + LOAMIUM_MODE クランプ
// ==========================================================================

describe('[AC-Sa10026-5-2] audit log and LOAMIUM_MODE clamp', () => {
  it('PUT settings/system records audit entry with op=settings.system.write', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });

    await fetch(`${server.baseUrl}/api/settings/system`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    });

    const log = await readAuditLog(vault);
    const entry = log.find((l) => l.op === 'settings.system.write');
    expect(entry).toBeDefined();
    expect(entry?.result).toBe('ok');
    expect(entry?.mode).toBe('full');
  });

  it('PUT settings/agent/connection records audit entry', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });

    await fetch(`${server.baseUrl}/api/settings/agent/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai',
        baseUrl: 'http://x/v1',
        model: 'x',
        apiKey: '$X',
      }),
    });

    const log = await readAuditLog(vault);
    const entry = log.find((l) => l.op === 'settings.agent.connection.write');
    expect(entry).toBeDefined();
    expect(entry?.result).toBe('ok');
  });

  it('PUT settings/agent/privacy records audit entry', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });

    await fetch(`${server.baseUrl}/api/settings/agent/privacy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deny: ['private/**'] }),
    });

    const log = await readAuditLog(vault);
    const entry = log.find((l) => l.op === 'settings.agent.privacy.write');
    expect(entry).toBeDefined();
  });

  it('mode=read-only: PUT settings/system returns 403 (denied) and records audit result=denied', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'read-only' });

    const res = await fetch(`${server.baseUrl}/api/settings/system`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    });
    expect(res.status).toBe(403);

    const log = await readAuditLog(vault);
    const denied = log.filter((l) => l.result === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]?.mode).toBe('read-only');
  });

  it('mode=append-only: PUT settings/agent/connection returns 403', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'append-only' });

    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai',
        baseUrl: 'http://x/v1',
        model: 'x',
        apiKey: '$X',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('mode=read-only: GET settings/system still works (200)', async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'read-only' });

    const res = await fetch(`${server.baseUrl}/api/settings/system`);
    expect(res.status).toBe(200);
  });
});

// ==========================================================================
// [AC-Sa10026-5-4] connection/test
// ==========================================================================

describe('[AC-Sa10026-5-4] connection test (POST /api/settings/agent/connection/test)', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('returns ok:false when baseUrl is unreachable (using inline key to force actual connection attempt)', async () => {
    // 実際に接続を試みるために $ENV ではなく inline key を使う (connection failed パス)
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1', // 接続不能
        model: 'stub',
        apiKeyRef: 'stub-key', // inline key — $ENV 解決をスキップして接続テストまで進む
      }),
    });
    expect(res.status).toBe(200); // 常に 200
    const body = (await res.json()) as { ok: boolean; error?: string; latencyMs?: number };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.latencyMs).toBeTypeOf('number');
  });

  it('returns ok:false when $ENV_VAR is not set', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'stub',
        apiKeyRef: '$THIS_ENV_VAR_DEFINITELY_NOT_SET_Sa10026',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('environment variable');
  });

  it('returns ok:false with no agent.json and no body params', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('returns ok:true when a local HTTP stub returns a valid response (via /models endpoint)', async () => {
    // ローカル HTTP スタブ: GET /models → 200 { data: [{ id: 'stub-model' }] }
    // 接続テストは model 不要の /models エンドポイントで疎通確認する
    const stub = await startStubServer((req, res2) => {
      if (req.method === 'GET' && req.url?.startsWith('/models')) {
        res2.writeHead(200, { 'content-type': 'application/json' });
        res2.end(JSON.stringify({ data: [{ id: 'stub-model-a' }, { id: 'stub-model-b' }] }));
      } else {
        res2.writeHead(404);
        res2.end();
      }
    });

    try {
      // apiKeyRef: 実際の値を直接渡す (テスト専用ケース — 接続テストエンドポイントは受け付ける)
      const res = await fetch(`${server.baseUrl}/api/settings/agent/connection/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api: 'openai',
          baseUrl: `http://127.0.0.1:${stub.port}`,
          apiKeyRef: 'stub-key', // $ENV でない実値 — 解決せずそのまま使う
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; models?: string[]; latencyMs?: number };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models).toContain('stub-model-a');
      expect(body.latencyMs).toBeTypeOf('number');
    } finally {
      await stub.stop();
    }
  });

  it('response does not contain apiKey value', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'stub',
        apiKeyRef: 'ACTUAL_SECRET_VALUE_12345',
      }),
    });
    const text = await res.text();
    expect(text).not.toContain('ACTUAL_SECRET_VALUE_12345');
  });
});

// ==========================================================================
// [AC-Sa10026-5-4] models list
// ==========================================================================

describe('[AC-Sa10026-5-4] models list (GET /api/settings/agent/models)', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('returns source:fallback with no agent.json', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: string[]; source: string; error?: string };
    expect(body.source).toBe('fallback');
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.error).toBeDefined();
  });

  it('returns source:fallback when $ENV_VAR for apiKey is not set', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://x/v1',
      model: 'x',
      apiKey: '$THIS_ENV_VAR_DEFINITELY_NOT_SET_Sa10026',
    });
    const res = await fetch(`${server.baseUrl}/api/settings/agent/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: string[]; source: string };
    expect(body.source).toBe('fallback');
    expect(body.models).toEqual([]);
  });

  it('returns source:fallback with unreachable baseUrl (still 200)', async () => {
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'stub',
      apiKey: 'stub-key',
    });
    const res = await fetch(`${server.baseUrl}/api/settings/agent/models`);
    expect(res.status).toBe(200); // 失敗時も 200 で直接入力を妨げない
    const body = (await res.json()) as { models: string[]; source: string };
    expect(body.source).toBe('fallback');
  });

  it('returns source:api with models from stub', async () => {
    // ローカル HTTP スタブ: GET /models → OpenAI 形式
    const stub = await startStubServer((req, res2) => {
      if (req.method === 'GET' && req.url === '/models') {
        res2.writeHead(200, { 'content-type': 'application/json' });
        res2.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      } else {
        res2.writeHead(404);
        res2.end();
      }
    });

    try {
      await seedAgentJson(vault, {
        api: 'openai',
        baseUrl: `http://127.0.0.1:${stub.port}`,
        model: 'model-a',
        apiKey: 'stub-key',
      });

      const res = await fetch(`${server.baseUrl}/api/settings/agent/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: string[]; source: string };
      expect(body.source).toBe('api');
      expect(body.models).toContain('model-a');
      expect(body.models).toContain('model-b');
    } finally {
      await stub.stop();
    }
  });
});
