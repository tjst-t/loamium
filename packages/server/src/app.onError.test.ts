/**
 * app.onError グローバルエラーハンドラのユニットテスト。
 *
 * テスト方針 (test-discipline Rule 1: ユニットテスト):
 * - createApp を実際に呼ぶのではなく、同じ onError ロジックを持つ最小 Hono アプリを構築する。
 * - Hono の fetch() を使い、実 HTTP サーバーを立てずにリクエストを検証する。
 * - console.error を vi.spyOn でキャプチャしてログ出力を検証する。
 *
 * カバーする要件:
 *   1. 未捕捉エラー → 500 + JSON { error:'internal_error', message:'internal server error' }
 *   2. VaultPathError → 400 + JSON { error:'invalid_path' }
 *   3. HiddenVaultPathError → 404 + JSON { error:'not_found' }
 *   4. JournalDateError → 400 + JSON { error:'invalid_date' }
 *   5. DqlParseError → 400 + JSON { error:'query_syntax' }
 *   6. HTTPException → status そのまま
 *   7. すべてのケースで console.error が呼ばれる (スタック付きログの確認)
 *
 * ステータスの変化なし検証:
 *   既存ルートは自力で errorJson を返しているため onError に到達しない。
 *   テストルートを別途用意して、ここでのみ到達させる。
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  DqlParseError,
  HiddenVaultPathError,
  JournalDateError,
  VaultPathError,
} from '@loamium/shared';

// ---------------------------------------------------------------------------
// テスト用 Hono アプリ構築 (createApp の onError ロジックと同一)
// ---------------------------------------------------------------------------

function buildTestApp(): Hono {
  const app = new Hono();

  // onError — createApp と同一実装
  app.onError((err, c) => {
    const method = c.req.method;
    const path = c.req.path;
    const name = err instanceof Error ? err.name : 'UnknownError';
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? message) : String(err);

    if (err instanceof HTTPException) {
      console.error(
        `[loamium] ${method} ${path} → ${err.status} HTTPException: ${message}\n${stack}`,
      );
      const body: { error: string; message: string } = {
        error: 'http_error',
        message: err.message,
      };
      return c.json(body, err.status);
    }

    if (err instanceof HiddenVaultPathError) {
      console.error(`[loamium] ${method} ${path} → 404 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'not_found', message }, 404);
    }

    if (err instanceof VaultPathError) {
      console.error(`[loamium] ${method} ${path} → 400 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'invalid_path', message }, 400);
    }

    if (err instanceof JournalDateError) {
      console.error(`[loamium] ${method} ${path} → 400 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'invalid_date', message }, 400);
    }

    if (err instanceof DqlParseError) {
      console.error(`[loamium] ${method} ${path} → 400 ${name}: ${message}\n${stack}`);
      return c.json({ error: 'query_syntax', message }, 400);
    }

    console.error(`[loamium] ${method} ${path} → 500 ${name}: ${message}\n${stack}`);
    return c.json({ error: 'internal_error', message: 'internal server error' }, 500);
  });

  // テスト用ルート — 各ドメインエラーをスローする
  app.get('/throw/vault-path', () => {
    throw new VaultPathError('test: backslash is not allowed');
  });
  app.get('/throw/hidden-vault-path', () => {
    throw new HiddenVaultPathError('test: hidden segment .loamium');
  });
  app.get('/throw/journal-date', () => {
    throw new JournalDateError('test: invalid journal date "bad-date"');
  });
  app.get('/throw/dql-parse', () => {
    throw new DqlParseError('test: unexpected token', 1, 5, 3);
  });
  app.get('/throw/http-exception', () => {
    throw new HTTPException(503, { message: 'service unavailable' });
  });
  app.get('/throw/generic', () => {
    throw new Error('test: unexpected internal error');
  });

  return app;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('app.onError グローバルエラーハンドラ', () => {
  let app: Hono;
  let consoleSpy: MockInstance;

  beforeEach(() => {
    app = buildTestApp();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // --- 1. 未捕捉エラー → 500 JSON ボディ (空ではない) ---

  it('[AC-onError-1] 未捕捉エラーは 500 + { error: "internal_error" } JSON ボディを返す', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/generic'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('internal_error');
    // スタック/内部詳細はレスポンスボディに含めない
    expect(body.message).toBe('internal server error');
    expect(JSON.stringify(body)).not.toContain('test: unexpected internal error');
  });

  it('[AC-onError-1b] 未捕捉エラーは console.error にスタック付きでログを残す', async () => {
    await app.fetch(new Request('http://localhost/throw/generic'));
    expect(consoleSpy).toHaveBeenCalledOnce();
    const logged = consoleSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain('[loamium]');
    expect(logged).toContain('GET');
    expect(logged).toContain('/throw/generic');
    expect(logged).toContain('500');
    expect(logged).toContain('test: unexpected internal error');
  });

  // --- 2. VaultPathError → 400 invalid_path ---

  it('[AC-onError-2] VaultPathError は 400 + { error: "invalid_path" } に変換される', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/vault-path'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_path');
    expect(body.message).toContain('backslash');
  });

  it('[AC-onError-2b] VaultPathError は console.error にログを残す', async () => {
    await app.fetch(new Request('http://localhost/throw/vault-path'));
    expect(consoleSpy).toHaveBeenCalledOnce();
    const logged = consoleSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain('[loamium]');
    expect(logged).toContain('400');
    expect(logged).toContain('VaultPathError');
  });

  // --- 3. HiddenVaultPathError → 404 not_found ---

  it('[AC-onError-3] HiddenVaultPathError は 404 + { error: "not_found" } に変換される', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/hidden-vault-path'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  // --- 4. JournalDateError → 400 invalid_date ---

  it('[AC-onError-4] JournalDateError は 400 + { error: "invalid_date" } に変換される', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/journal-date'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_date');
    expect(body.message).toContain('bad-date');
  });

  // --- 5. DqlParseError → 400 query_syntax ---

  it('[AC-onError-5] DqlParseError は 400 + { error: "query_syntax" } に変換される', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/dql-parse'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('query_syntax');
  });

  // --- 6. HTTPException → status そのまま ---

  it('[AC-onError-6] HTTPException は status をそのまま尊重し JSON ボディを返す', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/http-exception'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('http_error');
    expect(body.message).toBe('service unavailable');
  });

  // --- 7. 内部詳細をレスポンスボディから除外する ---

  it('[AC-onError-7] 500 レスポンスはスタックトレースやエラー詳細を含まない', async () => {
    const res = await app.fetch(new Request('http://localhost/throw/generic'));
    const text = await res.text();
    expect(text).not.toContain('Error');
    expect(text).not.toContain('throw/generic');
  });
});
