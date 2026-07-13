/**
 * グローバル onError ハンドラの受け入れテスト (実サーバー)。
 *
 * test-discipline Rule 2 (api): 実サーバー + 実 HTTP クライアント (fetch)。
 *
 * カバーする要件:
 *   1. ドメインエラー (VaultPathError) がルートで捕捉されない場合でも
 *      4xx JSON ボディを返す (backstop として機能する)。
 *   2. 通常の GET /api/notes リクエストは従来通り 200 を返す
 *      (onError は正常パスを一切変更しない)。
 *   3. 存在しないパスへの PUT は 400 invalid_path (各ルートが既に捕捉しているため
 *      onError に到達しないが、JSON ボディ形式が一貫していることを確認)。
 *   4. 意図的に 500 を引き起こす手段がないため、ユニットテストで 500 を補う。
 *
 * Note: グローバル onError の 500 ケースは packages/server/src/app.onError.test.ts
 * でユニットテスト (console.error spy + JSON 500 ボディ) によりカバーしている。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
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
  // ノートを1件置いてインデックスが空でない状態に
  await writeFile(path.join(vault, 'index.md'), '# index\n\ntest note.\n', 'utf8');
  server = await startServer({ vault });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await cleanupVault(server.vault);
});

describe('[AC-onError-accept-1] 通常リクエストは onError を通らない', () => {
  it('GET /api/notes は 200 を返す (onError が正常パスを壊さない)', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: unknown[] };
    expect(Array.isArray(body.notes)).toBe(true);
  });

  it('GET /api/health は 200 を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe('[AC-onError-accept-2] ドメインエラーはルートまたは onError バックストップで 4xx JSON を返す', () => {
  it('パス走査攻撃 (../) は 400 + { error: "invalid_path" } JSON を返す', async () => {
    // このパスは routes/notes.ts が直接 VaultPathError を errorJson に変換しているが、
    // ボディ形式の一貫性 (onError のフォールバックと同じ形) を確認する
    const res = await fetch(`${server.baseUrl}/api/notes/..%2Fescape.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'evil\n' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_path');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('無効な journal date (GET /api/journal?date=bad) は 400 + { error: "invalid_date" }', async () => {
    const res = await fetch(`${server.baseUrl}/api/journal?date=not-a-date`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_date');
    expect(typeof body.message).toBe('string');
  });

  it('DQL 構文エラー (POST /api/query) は 400 + { error: "query_syntax" }', async () => {
    const res = await fetch(`${server.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'INVALID DQL QUERY @@' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('query_syntax');
  });
});

describe('[AC-onError-accept-3] 404 は空ボディではなく JSON を返す', () => {
  it('GET /api/notes/nonexistent.md は 404 + { error: "not_found" } JSON を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/notes/nonexistent.md`);
    expect(res.status).toBe(404);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});
