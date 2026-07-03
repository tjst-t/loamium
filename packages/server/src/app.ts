import { Hono } from 'hono';
import type { HealthResponse } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { AppEnv } from './http.js';
import { notesRoutes } from './routes/notes.js';

export function createApp(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/health', (c) => {
    const res: HealthResponse = { status: 'ok', mode: config.mode };
    return c.json(res);
  });

  app.route('/', notesRoutes(config));

  return app;
}
