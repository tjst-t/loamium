/**
 * HTTP ヘルパー — エラーレスポンス、zod ボディ検証、監査コンテキスト。
 */
import type { Context } from 'hono';
import type { z } from 'zod';
import type { ErrorResponse } from '@loamium/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * 監査コンテキスト。書き込み系ハンドラが正規化済みパスと操作名をセットし、
 * 監査ミドルウェアがレスポンス確定後に .loamium/audit.log へ記録する。
 */
export interface AuditInfo {
  op: string;
  path: string;
}

/** アプリ全体で共有する Hono の Env 型 (Variables を型安全に使う)。 */
export type AppEnv = {
  Variables: {
    audit?: AuditInfo;
  };
};

export function setAudit(c: Context<AppEnv>, op: string, path: string): void {
  c.set('audit', { op, path });
}

export function getAudit(c: Context<AppEnv>): AuditInfo | undefined {
  return c.get('audit');
}

export function errorJson(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  error: string,
  message: string,
): Response {
  const body: ErrorResponse = { error, message };
  return c.json(body, status);
}

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/** JSON ボディを読み、zod スキーマで検証する。失敗は 400。 */
export async function parseBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<ParsedBody<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      response: errorJson(c, 400, 'invalid_json', 'request body must be valid JSON'),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, response: errorJson(c, 400, 'invalid_request', message) };
  }
  return { ok: true, data: parsed.data as z.infer<S> };
}
