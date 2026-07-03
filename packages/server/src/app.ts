import { Hono } from 'hono';
import type { HealthResponse } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { AppEnv } from './http.js';
import { notesRoutes } from './routes/notes.js';
import { journalRoutes } from './routes/journal.js';
import { auditMiddleware } from './audit.js';
import { permissionMiddleware } from './permissions.js';

export function createApp(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/health', (c) => {
    const res: HealthResponse = { status: 'ok', mode: config.mode };
    return c.json(res);
  });

  // 監査ログが権限チェックを包む (403 拒否も result: denied で記録される)
  app.use('/api/*', auditMiddleware(config));
  app.use('/api/*', permissionMiddleware(config));

  app.route('/', journalRoutes(config));
  app.route('/', notesRoutes(config));

  return app;
}
