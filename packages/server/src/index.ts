import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { VaultIndex } from './noteIndex.js';
import { startWatcher } from './watcher.js';

const config = configFromEnv();

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`invalid PORT: ${process.env.PORT ?? ''}`);
}

// インデックスは使い捨て・ファイルが正: 起動時に vault 全走査で構築してから受け付ける
const index = new VaultIndex(config.vaultRoot);
await index.build();

const app = createApp(config, index);

// API 外の変更 (外部エディタ・Git) にも追従する
const watcher = startWatcher(config.vaultRoot, index);

const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  // テスト/CLI がポートを検出できるよう、必ずこの 1 行を出す
  console.log(
    `loamium server listening on http://127.0.0.1:${info.port} (vault=${config.vaultRoot}, mode=${config.mode}, indexed=${index.size} notes)`,
  );
});

const shutdown = (): void => {
  void watcher.close().finally(() => {
    server.close(() => process.exit(0));
    // クローズ待ちで固まらないよう保険
    setTimeout(() => process.exit(0), 2000).unref();
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
