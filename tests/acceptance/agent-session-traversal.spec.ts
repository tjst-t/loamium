/**
 * [AC-S53409d-2-3] セキュリティ回帰テスト: セッション ID パストラバーサル拒否。
 *
 * GET /api/agent/sessions/:id に悪意あるセッション ID を渡した場合に
 * 4xx を返し vault 外のファイルを読み込まないことを確認する。
 *
 * 実サーバー + 実 HTTP クライアント (server.ts ハーネス使用)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('[AC-S53409d-2-3] GET /api/agent/sessions/:id — path traversal rejection', () => {
  it('rejects percent-encoded ../ traversal (..%2F..%2F..%2Fetc%2Fpasswd) with 4xx', async () => {
    // fetch は .. を URL 正規化で潰すため %2F で送る
    const res = await fetch(
      `${server.baseUrl}/api/agent/sessions/..%2F..%2F..%2Fetc%2Fpasswd`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_session_id');
  });

  it('rejects plain dot-dot traversal (../escape) with 4xx', async () => {
    // hono の :id param は / で区切られるため ..%2Fescape でパラメータ全体を渡す
    const res = await fetch(
      `${server.baseUrl}/api/agent/sessions/..%2Fescape`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_session_id');
  });

  it('rejects session id with path separator characters with 4xx', async () => {
    const maliciousIds = [
      '..%2Faudit.log',           // relative path to audit log
      'foo%2Fbar',                // slash inside id
      'foo%00bar',                // null byte
      '%2Fetc%2Fpasswd',          // absolute path component
    ];
    for (const id of maliciousIds) {
      const res = await fetch(`${server.baseUrl}/api/agent/sessions/${id}`);
      expect(res.status, `id=${id} should be rejected`).toBeGreaterThanOrEqual(400);
      expect(res.status, `id=${id} should not be 5xx`).toBeLessThan(500);
    }
  });

  it('accepts a well-formed session id (alphanumeric + hyphens + underscores)', async () => {
    // 存在しないセッション ID だが拒否はされない — 404 または空 messages が返る
    const res = await fetch(
      `${server.baseUrl}/api/agent/sessions/valid-session_123ABC`,
    );
    // 400 は返ってはいけない (id 検証を通過する)
    expect(res.status).not.toBe(400);
    // agent.json 未設定なので messages:[] になる
    const body = (await res.json()) as { id: string; messages: unknown[] };
    expect(body.id).toBe('valid-session_123ABC');
    expect(Array.isArray(body.messages)).toBe(true);
  });
});
