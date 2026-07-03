import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();
const app = createApp(config);

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`invalid PORT: ${process.env.PORT ?? ''}`);
}

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  // テスト/CLI がポートを検出できるよう、必ずこの 1 行を出す
  console.log(
    `loamium server listening on http://127.0.0.1:${info.port} (vault=${config.vaultRoot}, mode=${config.mode})`,
  );
});
