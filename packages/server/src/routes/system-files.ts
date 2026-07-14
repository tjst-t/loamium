/**
 * system/ 設定ファイルの一覧 + ソース読み書き (Sa10026-9 #1)。
 *
 * GET /api/system-files                       system/** の全ファイル (yaml + md) をフォルダ構造付きで列挙
 * GET /api/system-files/{path}/source         system/ 配下ファイルの生テキスト読み取り (yaml / md)
 * PUT /api/system-files/{path}/source         system/ 配下ファイルへの生テキスト書き込み
 *
 * 背景:
 *   - `GET /api/notes` は .md 専用インデックスなので settings.yaml / smart-folders/*.yaml を返さない。
 *   - `normalizeVaultPath` は拡張子を .md に矯正するため notes API では yaml を開けない。
 *   - サイドバー #4 の system/ ツリーと設定画面は、yaml / md を同じ編集エディタで扱う必要がある。
 *   ここで system/ に閉じた列挙 + source read/write を提供する (commands/*.yaml の source API と同型)。
 *
 * セキュリティ:
 *   - パスは必ず normalizeVaultFilePath (NFC / traversal / hidden 拒否) を経由し、
 *     さらに "system/" プレフィックスに閉じ込める (それ以外は 400 invalid_path)。
 *   - GET は read として全モードで許可。PUT は mutate に分類され read-only / append-only では
 *     permissionMiddleware が 403 を返す (settings PUT と同じ)。
 *   - 書き込みは監査ログに記録する (CLAUDE.md: 書き込み系 API は監査ログ)。
 *   - agent ツールとしては公開しない (通常の HTTP ルートのみ — 自己昇格防止と同方針)。
 */
import { Hono } from 'hono';
import {
  normalizeVaultFilePath,
  SYSTEM_DIR,
  systemFileSourceWriteRequestSchema,
  VaultPathError,
  type SystemFileListResponse,
  type SystemFileSourceResponse,
  type SystemFileSourceWriteResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { listSystemFiles, noteMtime, readNote, writeNote } from '../vault.js';
import { writeAuditEntry } from '../audit.js';

const SOURCE_PREFIX = '/api/system-files/';
const SOURCE_SUFFIX = '/source';

/**
 * リクエストパスから system/ 配下の vault 相対パスを取り出して検証する。
 * - `/api/system-files/{path}/source` の {path} 部を取り出す
 * - normalizeVaultFilePath で NFC / traversal / hidden を検証
 * - "system/" プレフィックスに閉じ込める (それ以外は VaultPathError)
 */
function systemPathFrom(rawPath: string): string {
  let rest = rawPath.slice(SOURCE_PREFIX.length);
  if (!rest.endsWith(SOURCE_SUFFIX)) {
    throw new VaultPathError(`system file path is missing before ${SOURCE_SUFFIX}`);
  }
  rest = rest.slice(0, rest.length - SOURCE_SUFFIX.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new VaultPathError('path is not valid percent-encoding');
  }
  const rel = normalizeVaultFilePath(decoded);
  if (rel !== SYSTEM_DIR && !rel.startsWith(`${SYSTEM_DIR}/`)) {
    throw new VaultPathError(`only system/ files are accessible here: ${rel}`);
  }
  return rel;
}

export function systemFilesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- 一覧: system/** の全ファイル (yaml + md その他) ----
  app.get('/api/system-files', async (c) => {
    const res: SystemFileListResponse = {
      files: await listSystemFiles(config.vaultRoot),
    };
    return c.json(res);
  });

  // ---- ソース読み取り ----
  app.get(`${SOURCE_PREFIX}*`, async (c) => {
    let rel: string;
    try {
      rel = systemPathFrom(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    const content = await readNote(config.vaultRoot, rel);
    const mtime = await noteMtime(config.vaultRoot, rel);
    if (content === null || mtime === null) {
      return errorJson(c, 404, 'not_found', `system file not found: ${rel}`);
    }
    const res: SystemFileSourceResponse = { path: rel, content, mtime };
    return c.json(res);
  });

  // ---- ソース書き込み ----
  // read-only / append-only では permissionMiddleware が mutate として 403 を返す。
  app.put(`${SOURCE_PREFIX}*`, async (c) => {
    let rel: string;
    try {
      rel = systemPathFrom(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    const body = await parseBody(c, systemFileSourceWriteRequestSchema);
    if (!body.ok) return body.response;
    const { content, mtime: baseMtime } = body.data;

    if (baseMtime !== undefined) {
      const existing = await noteMtime(config.vaultRoot, rel);
      if (existing !== null && existing !== baseMtime) {
        return errorJson(
          c,
          409,
          'conflict',
          `system file has been modified since mtime=${String(baseMtime)}`,
        );
      }
    }

    setAudit(c, 'system.file.write', rel);
    const { created, mtime } = await writeNote(config.vaultRoot, rel, content);
    await writeAuditEntry(config, {
      ts: new Date().toISOString(),
      op: 'system.file.write',
      path: rel,
      mode: config.mode,
      result: 'ok',
      status: 200,
    });
    const res: SystemFileSourceWriteResponse = { path: rel, created, mtime };
    return c.json(res);
  });

  return app;
}
