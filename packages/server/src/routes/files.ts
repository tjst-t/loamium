/**
 * files エンドポイント (S9e5ca4-2)。
 *
 * - GET /api/files/{path}   vault 内ファイルの読み取り専用配信 (画像・添付等)
 *
 * 書き込み系 (PUT/POST/DELETE) は提供しない — このモジュールは GET しか
 * 登録しないので、他メソッドは Hono の 404 に落ちる (AC-S9e5ca4-2-1)。
 * 読み取りなので permission ミドルウェアの全モード (read-only 含む) で許可される。
 *
 * パス検証は shared の normalizeVaultFilePath を経由 (CLAUDE.md):
 * - traversal / 絶対パス等の不正パス → 400 invalid_path
 * - 隠しセグメント (.loamium / .git / .obsidian) → 404 (存在自体を隠す)
 */
import { Hono } from 'hono';
import { HiddenVaultPathError, normalizeVaultFilePath, VaultPathError } from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { readVaultFile } from '../vault.js';
import { errorJson, type AppEnv } from '../http.js';

const FILES_PREFIX = '/api/files/';

/**
 * 拡張子 → Content-Type の最小マップ。
 * 未知の拡張子は application/octet-stream (ブラウザに実行させない安全側)。
 * .html を text/html で返すと vault 内の任意 HTML が同一オリジンで実行される
 * ため、テキスト系は text/plain に倒す (DESIGN_PRINCIPLES priority 2)。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  htm: 'text/plain; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function contentTypeOf(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function filesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(`${FILES_PREFIX}*`, async (c) => {
    let rel: string;
    try {
      let decoded: string;
      try {
        decoded = decodeURIComponent(c.req.path.slice(FILES_PREFIX.length));
      } catch {
        throw new VaultPathError('path is not valid percent-encoding');
      }
      rel = normalizeVaultFilePath(decoded);
    } catch (err) {
      if (err instanceof HiddenVaultPathError) {
        // 隠し領域は存在自体を隠す (audit.log 等の内容漏えい防止)
        return errorJson(c, 404, 'not_found', 'file not found');
      }
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    const buf = await readVaultFile(config.vaultRoot, rel);
    if (buf === null) {
      return errorJson(c, 404, 'not_found', `file not found: ${rel}`);
    }
    return c.body(new Uint8Array(buf), 200, {
      'content-type': contentTypeOf(rel),
      'x-content-type-options': 'nosniff',
    });
  });

  return app;
}
