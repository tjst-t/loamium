/**
 * GET /api/events — SSE イベントストリーム (Sd5c9f4-3)。
 *
 * ファイル変更・スマートフォルダキャッシュ無効化イベントを配信する
 * UI 受動購読インフラ。エージェントが操作する対象ではない (ADR-0014)。
 *
 * 配信イベント:
 *   { type:'sf_invalidated', affectedIds: string[] }  — SF キャッシュ無効 (空なら送信しない)
 *   { type:'notes_changed', path: string, op:'upsert'|'delete' }  — ノート変更
 *   : keepalive  — keep-alive コメント (約 25 秒ごと)
 *
 * 権限: GET なので permissionMiddleware では 'read' に分類され、
 * read-only / append-only モードでも遮断されない (AC-Sd5c9f4-3-5)。
 *
 * NOTE: SSE は UI 受動購読インフラであり、エージェントが操作する対象ではないため
 * エージェントツールは追加しない。この判断を agent-help.ts に記録している (ADR-0014)。
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { AppEnv } from '../http.js';
import type { SSEBroadcaster } from '../sse-broadcaster.js';

const KEEPALIVE_INTERVAL_MS = 25_000;

export function eventsRoutes(broadcaster: SSEBroadcaster): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/events', (c) => {
    return stream(c, async (s) => {
      // SSE ヘッダ — Hono の stream() は Content-Type を自動でセットしないため明示する
      c.res.headers.set('Content-Type', 'text/event-stream');
      c.res.headers.set('Cache-Control', 'no-cache');
      c.res.headers.set('Connection', 'keep-alive');

      // broadcaster に登録 (切断時に解除される)
      const unsubscribe = broadcaster.subscribe({
        write: (data: string): Promise<void> => s.write(data).then(() => undefined),
      });

      // keep-alive コメント (約 25 秒ごと)
      const keepAliveTimer = setInterval(() => {
        if (s.aborted) return;
        s.write(': keepalive\n\n').catch((err: unknown) => {
          console.error('[loamium] SSE keepalive write error:', err);
        });
      }, KEEPALIVE_INTERVAL_MS);

      // 切断時のクリーンアップ
      s.onAbort(() => {
        clearInterval(keepAliveTimer);
        unsubscribe();
      });

      // 接続を維持する — クライアントが切断するまでビジーウェイトを避けて待機。
      // s.aborted が true になるまで短いインターバルで確認する。
      // (Hono の stream() は関数が return すると接続が閉じるため、
      //  クライアント切断まで保留し続ける必要がある)
      while (!s.aborted) {
        await s.sleep(1000);
      }
      clearInterval(keepAliveTimer);
      unsubscribe();
    });
  });

  return app;
}
