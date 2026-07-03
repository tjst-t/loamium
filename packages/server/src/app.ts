import { Hono } from 'hono';
import type { HealthResponse } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { AppEnv } from './http.js';
import { notesRoutes } from './routes/notes.js';
import { journalRoutes } from './routes/journal.js';
import { searchRoutes } from './routes/search.js';
import { auditMiddleware } from './audit.js';
import { permissionMiddleware } from './permissions.js';
import { indexSyncMiddleware } from './indexSync.js';
import type { VaultIndex } from './noteIndex.js';

export function createApp(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/health', (c) => {
    const res: HealthResponse = { status: 'ok', mode: config.mode };
    return c.json(res);
  });

  // 監査ログが権限チェックを包む (403 拒否も result: denied で記録される)。
  // indexSync は書き込み成功後にインデックスを即時更新する (write-through)。
  app.use('/api/*', auditMiddleware(config));
  app.use('/api/*', permissionMiddleware(config));
  app.use('/api/*', indexSyncMiddleware(index));

  // searchRoutes の GET /api/notes (一覧) は notesRoutes の /api/notes/{path} と
  // プレフィックスが異なるため衝突しない (先に登録して明確化)
  app.route('/', searchRoutes(index));
  app.route('/', journalRoutes(config));
  app.route('/', notesRoutes(config, index));

  return app;
}
