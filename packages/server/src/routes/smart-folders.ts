/**
 * スマートフォルダ定義 CRUD・解決 (S32940c-2, Sa10026-2-2)。
 *
 * POST-Sa10026-2 正本: system/smart-folders/*.yaml (per-file YAML) for query items
 *                      .loamium/smart-folders.json (pin-only JSON) for pin items
 *
 * GET  /api/smart-folders             → system/ (query) + JSON (pin) をマージして返す
 * PUT  /api/smart-folders             → query → system/ per-file YAML, pin → JSON
 * GET  /api/smart-folders/{id}/notes  → { notes: NoteMeta[] } (query→executeQuery, pin→1件)
 *
 * ADR-0016 (Sc4b9d1-1): readConfig / PUT の YAML 直列化・pin JSON 同期 / notes 解決は
 * smart-folders-service.ts の純関数へ切り出し済み。REST と agent ツールの双方が同一経路を通る。
 * このルートは HTTP 境界 (パース・エラー整形・監査) のみを担い、ロジックはサービス層に委譲する。
 *
 * 書き込み系: 監査ログ (op: 'smart-folders.write')、read-only/append-only は 403。
 * ADR-0010 (Sa10026-2): system/ が query の正本、pin は JSON に保持。
 */
import { Hono } from 'hono';
import {
  smartViewConfigSchema,
  type SmartFoldersResolveResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import {
  normalizePinPaths,
  readSmartFoldersConfig,
  resolveSmartFolderNotes,
  writeSmartFoldersConfig,
} from '../smart-folders-service.js';

export function smartFoldersRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- GET /api/smart-folders -----------------------------------------------
  app.get('/api/smart-folders', async (c) => {
    const cfg = await readSmartFoldersConfig(config.vaultRoot);
    return c.json(cfg);
  });

  // ---- PUT /api/smart-folders -----------------------------------------------
  app.put('/api/smart-folders', async (c) => {
    setAudit(c, 'smart-folders.write', 'system/smart-folders/');

    const body = await parseBody(c, smartViewConfigSchema);
    if (!body.ok) return body.response;

    // pin.path を正規化 (NFC)
    const normalized = normalizePinPaths(body.data.items);
    if (!normalized.ok) {
      return errorJson(c, 400, 'invalid_path', `pin "${normalized.id}": ${normalized.message}`);
    }

    await writeSmartFoldersConfig(config.vaultRoot, normalized.items);

    const cfg = { version: body.data.version, items: normalized.items };
    return c.json(cfg);
  });

  // ---- GET /api/smart-folders/{id}/notes ------------------------------------
  app.get('/api/smart-folders/:id/notes', async (c) => {
    const id = c.req.param('id');
    const resolved = await resolveSmartFolderNotes(config.vaultRoot, index, id);
    if (!resolved.ok) {
      if (resolved.reason === 'not_found') {
        return errorJson(c, 404, 'not_found', `smart folder "${id}" not found`);
      }
      return errorJson(c, 500, 'dql_error', `stored dql is invalid: ${resolved.message}`);
    }
    const res: SmartFoldersResolveResponse = { notes: resolved.notes };
    return c.json(res);
  });

  return app;
}
