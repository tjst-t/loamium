/**
 * 書き込み API 成功後のインデックス即時更新 (write-through)。
 *
 * ARCHITECTURE の書き込みフロー「ファイル書き込み → 監査ログ追記 → インデックス即時更新」の
 * 実装。書き込み系ハンドラは監査コンテキスト (op + 正規化済み相対パス) を必ずセットするので、
 * それをフックにレスポンス確定後に該当ファイルだけ再読込する。
 * ファイルが正: refreshFile はディスクを読み直すだけなので、chokidar 側の更新と競合しない。
 */
import type { MiddlewareHandler } from 'hono';
import { getAudit, type AppEnv } from './http.js';
import type { VaultIndex } from './noteIndex.js';

export function indexSyncMiddleware(index: VaultIndex): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const audit = getAudit(c);
    if (!audit || c.res.status >= 400) return;
    try {
      await index.refreshFile(audit.path);
    } catch (err) {
      // インデックス更新失敗でファイル書き込み済みの応答を壊さない (ファイルが正)。
      // 握りつぶさず stderr に残す — 次の watch イベント / 再起動で自己修復する。
      console.error(`[loamium] index refresh failed for ${audit.path}:`, err);
    }
  };
}
