/**
 * 監査ログミドルウェア。
 *
 * すべての書き込み系 API 呼び出しを {vault}/.loamium/audit.log に JSONL で記録する
 * (DESIGN_PRINCIPLES architecture: エージェントの権限境界と監査ログを最初から持つ)。
 *
 * - 成功 (2xx) は result: "ok"
 * - 権限モードによる拒否 (403) は result: "denied"
 * - その他の失敗 (4xx/5xx) は result: "error"
 * - 読み取り系は記録しない。ただし GET /api/journal の自動生成は
 *   ディスク書き込みなのでハンドラが setAudit した場合のみ記録する。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { AuditEntry } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { getAudit, type AppEnv } from './http.js';

const WRITE_METHODS = new Set(['PUT', 'POST', 'DELETE']);

/** ハンドラが実行されなかった場合 (403 拒否・400 パス不正) の op 推定。 */
export function deriveOp(method: string, reqPath: string): string {
  if (reqPath === '/api/journal/append') return 'journal.append';
  if (reqPath.startsWith('/api/notes/')) {
    if (method === 'PUT') return 'note.write';
    if (method === 'DELETE') return 'note.delete';
    if (method === 'POST') {
      if (reqPath.endsWith('/append')) return 'note.append';
      if (reqPath.endsWith('/patch')) return 'note.patch';
      if (reqPath.endsWith('/rename')) return 'note.rename';
      return 'note.unknown';
    }
  }
  return `${method.toLowerCase()}.unknown`;
}

export function auditMiddleware(config: ServerConfig): MiddlewareHandler<AppEnv> {
  const auditDir = path.join(config.vaultRoot, '.loamium');
  const auditLog = path.join(auditDir, 'audit.log');

  return async (c, next) => {
    await next();

    const info = getAudit(c);
    const isWriteCall = WRITE_METHODS.has(c.req.method) && c.req.path.startsWith('/api/');
    if (!info && !isWriteCall) {
      return; // 読み取り系 (自動生成なし) は記録しない
    }

    const status = c.res.status;
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      op: info?.op ?? deriveOp(c.req.method, c.req.path),
      path: info?.path ?? c.req.path,
      mode: config.mode,
      result: status < 400 ? 'ok' : status === 403 ? 'denied' : 'error',
      status,
    };

    try {
      await mkdir(auditDir, { recursive: true });
      await appendFile(auditLog, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      // 監査ログが書けない場合でも API 応答は返す (ファイル正本は壊さない)。
      // ただし無言では握りつぶさず stderr に残す。
      console.error(`[loamium] failed to write audit log: ${String(err)}`);
    }
  };
}
