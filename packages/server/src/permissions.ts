/**
 * 権限モードミドルウェア (LOAMIUM_MODE: full / read-only / append-only)。
 *
 * - read-only:   すべての書き込み系 (append 含む) を 403 で拒否
 * - append-only: 追記 (notes append / journal append) のみ許可。
 *                上書き (PUT)・部分置換 (patch)・削除 (DELETE) は 403
 * - full:        制限なし
 *
 * 分類できない書き込みメソッドは安全側 (mutate 扱い) に倒す
 * (DESIGN_PRINCIPLES priority 2: 迷ったらファイルを守る側に倒す)。
 */
import type { MiddlewareHandler } from 'hono';
import type { ServerConfig } from './config.js';
import { errorJson, type AppEnv } from './http.js';

export type OpKind = 'read' | 'append' | 'mutate';

export function classifyOp(method: string, reqPath: string): OpKind {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'read';
  if (method === 'POST') {
    if (reqPath === '/api/journal/append') return 'append';
    if (reqPath.startsWith('/api/notes/') && reqPath.endsWith('/append')) return 'append';
    return 'mutate';
  }
  // PUT / DELETE / PATCH / その他の書き込みメソッド
  return 'mutate';
}

export function permissionMiddleware(config: ServerConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const kind = classifyOp(c.req.method, c.req.path);
    if (kind === 'read' || config.mode === 'full') {
      return next();
    }
    if (config.mode === 'read-only') {
      return errorJson(
        c,
        403,
        'forbidden',
        `mode=read-only: write operations are not allowed (${kind})`,
      );
    }
    // append-only
    if (kind !== 'append') {
      return errorJson(
        c,
        403,
        'forbidden',
        'mode=append-only: only append operations are allowed (overwrite/patch/delete are forbidden)',
      );
    }
    return next();
  };
}
