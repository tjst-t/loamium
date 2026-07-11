/**
 * Story S53409d-1-2「ターミナル機構の完全削除」受け入れテスト。
 *
 * [AC-S53409d-1-2a] GET /api/terminal は 404 を返す (ルート自体が存在しない)。
 * [AC-S53409d-1-2b] GET /api/health のレスポンスに terminal キーが存在しない。
 *
 * test-discipline Rule 2: 実サーバーを起動し実 HTTP クライアントで検証する。
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
  server = await startServer({ vault, mode: 'full' });
});

afterAll(async () => {
  await server.stop();
  await cleanupVault(server.vault);
});

describe('[AC-S53409d-1-2] /api/terminal 廃止 + health に terminal フィールドなし', () => {
  it('[AC-S53409d-1-2a] GET /api/terminal は 404 を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/terminal`);
    expect(res.status).toBe(404);
  });

  it('[AC-S53409d-1-2b] GET /api/health のレスポンスに terminal キーが含まれない', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.mode).toBeDefined();
    expect('terminal' in body).toBe(false);
  });
});
