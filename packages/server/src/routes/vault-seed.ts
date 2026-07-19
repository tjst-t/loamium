/**
 * POST /api/vault/seed — サンプルファイルを vault へ投入する (S7e2d5c-1)。
 *
 * - ボディ: { force?: boolean } (zod: vaultSeedRequestSchema)
 * - 書込モード (mode=write) でのみ許可 (read-only / append-only は 403)。
 *   → permissionMiddleware が POST を mutate として 403 にする。
 *   ただし classifyOp は /api/vault/seed を mutate にしないと append-only でも弾かれる。
 *   明示 403 でモード検査を行い、わかりやすいメッセージを返す。
 * - SeedService.seed() 経由でコピー (ADR-0016: 監査済みサービス層)。
 * - 監査ログに op: 'vault.seed' を記録する。
 */
import { Hono } from 'hono';
import {
  vaultSeedRequestSchema,
  type VaultSeedResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { parseBody, errorJson, setAudit, type AppEnv } from '../http.js';
import { writeAuditEntry } from '../audit.js';
import { seed } from '../seed-service.js';

export function vaultSeedRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * POST /api/vault/seed
   *
   * サンプルファイルを vault へ投入する。
   * - read-only / append-only では 403 (permissionMiddleware が mutate として弾く)。
   * - さらにここで mode=full だけを許可する明示チェックを追加し、わかりやすいメッセージを返す。
   */
  app.post('/api/vault/seed', async (c) => {
    // write-mode (full) でのみ許可 (ADR-0015 ケーパビリティ制約と整合)
    if (config.mode !== 'full') {
      return errorJson(
        c,
        403,
        'forbidden',
        `mode=${config.mode}: vault seed requires write mode (full)`,
      );
    }

    const body = await parseBody(c, vaultSeedRequestSchema);
    if (!body.ok) return body.response;

    const { force = false } = body.data;

    const result = await seed(config.vaultRoot, force);

    setAudit(c, 'vault.seed', config.vaultRoot);
    await writeAuditEntry(config, {
      ts: new Date().toISOString(),
      op: 'vault.seed',
      path: config.vaultRoot,
      mode: config.mode,
      result: 'ok',
      status: 200,
    });

    const res: VaultSeedResponse = { seeded: result.seeded, skipped: result.skipped };
    return c.json(res);
  });

  return app;
}
