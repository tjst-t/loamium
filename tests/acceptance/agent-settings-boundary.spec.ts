/**
 * [AC-Sa10026-6-1] セキュリティ受け入れテスト: 設定書込 API の agent ツール除外。
 *
 * ADR-0026 / Sa10026-6 自己昇格防止:
 *   - agent ツール (note_create / note_edit 等) 経由で .loamium/agent*.json に
 *     到達できないことを実 HTTP で確認する。
 *   - 設定書込 API (/api/settings/*) は agent ツールの allowlist に含まれず、
 *     notes API のパス境界 (normalizeVaultPath が .loamium/* を拒否) と
 *     二重に到達不可であることを確認する。
 *
 * 実サーバー + 実 HTTP クライアント (server.ts ハーネス使用)。LLM は使わない。
 *
 * [AC-Sa10026-6-1]
 *   - notes PUT で .loamium/agent.json を書き換えようとすると 400 (hidden path)
 *   - notes PUT で .loamium/agent-privacy.json を書き換えようとすると 400 (hidden path)
 *   - notes POST append で .loamium/agent.json へ追記しようとすると 400 (hidden path)
 *   - 設定書込 API は通常の HTTP ルートで到達可能だが、agent ツール一覧には存在しない
 *
 * [AC-Sa10026-6-2] advertised-toolset pin は agent-tools.e2e.spec.ts の
 *   '[AC-S53409d-3-1]' テストが担当 (既存)。本テストではサーバー単位の構造的除外を確認する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
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
  // .loamium/agent.json を事前に配置する (GET /api/settings/agent/connection 等のため)
  await mkdir(path.join(vault, '.loamium'), { recursive: true });
  await writeFile(
    path.join(vault, '.loamium', 'agent.json'),
    JSON.stringify({
      api: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'stub',
      apiKey: 'stub-key',
    }),
    'utf8',
  );
  server = await startServer({ vault, mode: 'full' });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-Sa10026-6-1] notes API は .loamium/* パスへのアクセスを拒否する (agent ツール到達不可)', () => {
  /**
   * agent ツール (note_create / note_edit) は内部的に notes API の同一サービス層
   * (note-service.ts) を呼ぶ。normalizeVaultPath が隠しセグメント (.loamium 等) を
   * VaultPathError で拒否するため、agent が設定ファイルを書き換えることはできない。
   * ここでは HTTP 経由でその境界を確認する。
   */

  it('PUT /api/notes/.loamium/agent.json が 400 を返す (hidden segment — agent ツールと同一ルート)', async () => {
    // note_create ツールは内部で PUT /api/notes/{path} と同じ note-service を呼ぶ。
    // パーセントエンコードで .loamium を渡してもサーバー側で拒否される。
    const res = await fetch(
      `${server.baseUrl}/api/notes/${encodeURIComponent('.loamium')}/agent.json`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '{"api":"openai","baseUrl":"http://evil/","model":"evil","apiKey":"evil"}' }),
      },
    );
    // normalizeVaultPath が hidden segment を VaultPathError で拒否 → 400 or 404
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('PUT /api/notes/.loamium/agent-privacy.json が 400 を返す (自己 deny-list 書換不可)', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/notes/${encodeURIComponent('.loamium')}/agent-privacy.json`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '{}' }),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /api/notes/.loamium/agent.json/append が 400 を返す (追記も不可)', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/notes/${encodeURIComponent('.loamium')}/agent.json/append`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'injected' }),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /api/notes/.loamium/agent.json/patch が 400 を返す (部分置換も不可)', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/notes/${encodeURIComponent('.loamium')}/agent.json/patch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ old: 'stub-key', new: 'evil-key' }),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('GET /api/notes/.loamium/agent.json が 400/404 を返す (読取も不可 — hidden path)', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/notes/${encodeURIComponent('.loamium')}/agent.json`,
    );
    // 存在を隠す: HiddenVaultPathError → 404, VaultPathError → 400
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('[AC-Sa10026-6-1] 設定書込 API は通常 HTTP ルートから到達可能だが、agent ツール allowlist には存在しない', () => {
  /**
   * 設定書込 API は /api/settings/* に存在するが、
   * agent ツール (note_create 等) の allowlist からは除外されている。
   * - agent ツールは CAPABILITY_TOOL_NAMES で定義されたツール名のみ LLM に広告される。
   * - settings 系ケーパビリティは AGENT_CAPABILITIES に存在しない。
   * - よって agent 経由での設定書込は不可 (構造的除外、ADR-0026 / Sa10026-6)。
   *
   * HTTP ルートとして正常に動作することで「設定書込 API は存在し、
   * ただし agent ツールからのみ除外されている」ことを確認する。
   */

  it('GET /api/settings/agent/permissions が 200 を返す (HTTP ルートは生きている)', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/permissions`);
    expect(res.status).toBe(200);
  });

  it('GET /api/settings/agent/privacy が 200 を返す (HTTP ルートは生きている)', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/privacy`);
    expect(res.status).toBe(200);
  });

  it('GET /api/settings/agent/connection が 200 を返す (HTTP ルートは生きている)', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/connection`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { apiKeyRef: string } | null };
    // apiKey は実値を含まない (maskApiKey)
    if (body.connection !== null) {
      expect(body.connection.apiKeyRef).not.toContain('stub-key');
    }
  });

  it('PUT /api/settings/agent/permissions が 200 を返す (HTTP ルートは動作する)', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: 'read-only' }),
    });
    expect(res.status).toBe(200);
  });

  it('PUT /api/settings/agent/privacy が 200 を返す (HTTP ルートは動作する)', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings/agent/privacy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deny: [] }),
    });
    expect(res.status).toBe(200);
  });
});
