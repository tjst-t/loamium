/**
 * 同期 API ルート (ADR-0032 / Se29635-2/3)。
 *
 * GET  /api/sync/status       — SyncStatus (git 不在でも available:false で 200)
 * GET  /api/sync/config       — 設定 (token は redact、tokenConfigured フラグのみ)
 * PUT  /api/sync/config       — 設定更新 (zod 検証 + configureRemote 呼び出し)
 * POST /api/sync/now          — syncNow() (commit→pull→push)
 * POST /api/sync/pull         — pull({reason})
 * POST /api/sync/push         — push()
 * POST /api/sync/flush        — scheduler.flush() (debounce 即時実行 / ブラー時) [Story 3]
 * PUT  /api/sync/credential   — PAT 保存 (0600, vault 外)
 *
 * セキュリティ:
 * - PUT/POST はすべて auditMiddleware 経由で監査ログに記録される。
 * - トークン実値はレスポンスに含めない。
 * - `GitUnavailableError` は 503 で返す (git 不在は同期機能のみ無効)。
 */
import { Hono } from 'hono';
import {
  syncConfigWriteRequestSchema,
  syncPullRequestSchema,
  syncCredentialWriteRequestSchema,
} from '@loamium/shared';
// syncConflictsResponseSchema は型ガード目的ではなく shape の参照用 (ランタイム検証は不要)
// シリアライズはエンジンの getLastConflicts() → FileConflict[] → response 変換で行う
import { GitUnavailableError } from '../sync/git-runner.js';
import type { SyncService } from '../sync-service.js';
import type { ServerConfig } from '../config.js';
import { parseBody, setAudit, errorJson, type AppEnv } from '../http.js';

/**
 * 同期 API ルートファクトリ。
 *
 * @param config - サーバー設定 (監査ログ・モード制御に使う)
 * @param service - `createSyncService` が返すエンジン + ストア + スケジューラ
 */
export function syncRoutes(config: ServerConfig, service: SyncService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { engine, store, scheduler } = service;

  // [AC-Se29635-2-3] 同期状態取得
  // git 不在でも throw しない (available:false を返す)
  app.get('/api/sync/status', async (c) => {
    try {
      const status = await engine.status();
      return c.json(status);
    } catch (err) {
      return errorJson(c, 500, 'sync_status_error', String(err));
    }
  });

  // [AC-Se29635-2-1] 設定取得 (token は redact)
  app.get('/api/sync/config', (c) => {
    const cfg = store.redactedConfig();
    return c.json(cfg);
  });

  // [AC-Se29635-2-1] 設定更新 + configureRemote 呼び出し
  app.put('/api/sync/config', async (c) => {
    setAudit(c, 'sync.config.write', '.loamium/sync.json');
    const bodyResult = await parseBody(c, syncConfigWriteRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    try {
      // partial merge + 永続化
      await store.save(bodyResult.data);
      // vault の git リモート設定を適用 (URL なし・git 不在はサイレントスキップ)
      await engine.configureRemote().catch((err: unknown) => {
        // configureRemote は非致命的 — git 不在 or 未初期化 vault では失敗しうる
        // ここでは設定保存は成功済みのため、エラーをログのみで記録する
        console.error('[loamium/sync] configureRemote failed:', String(err));
      });
      const cfg = store.redactedConfig();
      return c.json(cfg);
    } catch (err) {
      return errorJson(c, 500, 'sync_config_write_error', String(err));
    }
  });

  // [AC-Se29635-2-3] 今すぐ同期 (commit→pull→push)
  app.post('/api/sync/now', async (c) => {
    setAudit(c, 'sync.now', '(remote)');
    try {
      const result = await engine.syncNow();
      return c.json(result);
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        return errorJson(c, 503, 'git_unavailable', err.message);
      }
      return errorJson(c, 500, 'sync_error', String(err));
    }
  });

  // [AC-Se29635-2-3] 手動 pull
  app.post('/api/sync/pull', async (c) => {
    setAudit(c, 'sync.pull', '(remote)');
    const bodyResult = await parseBody(c, syncPullRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    try {
      const result = await engine.pull(bodyResult.data.reason);
      return c.json(result);
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        return errorJson(c, 503, 'git_unavailable', err.message);
      }
      return errorJson(c, 500, 'sync_error', String(err));
    }
  });

  // push
  app.post('/api/sync/push', async (c) => {
    setAudit(c, 'sync.push', '(remote)');
    try {
      const result = await engine.push();
      return c.json(result);
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        return errorJson(c, 503, 'git_unavailable', err.message);
      }
      return errorJson(c, 500, 'sync_error', String(err));
    }
  });

  // [AC-Se29635-3-1] ウィンドウブラー / アプリ終了時に pending debounce を即時実行する
  // body なし、レスポンスは最新の SyncStatus を返す (UI がすぐに表示を更新できる)
  app.post('/api/sync/flush', async (c) => {
    setAudit(c, 'sync.flush', '(scheduler)');
    try {
      await scheduler.flush();
      const status = await engine.status();
      return c.json(status);
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        return errorJson(c, 503, 'git_unavailable', err.message);
      }
      return errorJson(c, 500, 'sync_flush_error', String(err));
    }
  });

  // [AC-Se29635-4-1] 最後に検出された未解決競合ハンク一覧
  // pull --rebase 後の自動解決で残ったハンクを返す。解消後は空配列。
  app.get('/api/sync/conflicts', (c) => {
    const rawConflicts = engine.getLastConflicts();
    const conflicts = rawConflicts.map((fc) => ({
      file: fc.file,
      hunks: fc.hunks.map((h) => ({ ours: h.ours, theirs: h.theirs })),
    }));
    return c.json({ conflicts });
  });

  // [AC-Se29635-2-2] PAT 保存 (0600, vault 外)
  // トークン実値はレスポンスに含めない
  app.put('/api/sync/credential', async (c) => {
    setAudit(c, 'sync.credential.write', '.loamium/sync-credentials.json');
    const bodyResult = await parseBody(c, syncCredentialWriteRequestSchema);
    if (!bodyResult.ok) return bodyResult.response;

    try {
      await store.setToken(bodyResult.data.token);
      return c.json({ ok: true });
    } catch (err) {
      return errorJson(c, 500, 'sync_credential_write_error', String(err));
    }
  });

  // config パラメータは現在未使用 (将来の監査拡張用)
  void config;

  return app;
}
