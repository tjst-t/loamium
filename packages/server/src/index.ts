import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { VaultIndex } from './noteIndex.js';
import { startWatcher } from './watcher.js';
import { runMigration } from './migrate.js';
import { startScheduler } from './agent-scheduler.js';
import { installEgressGuard } from './egress-guard.js';

// オフライン acceptance ハーネス (S8a3f2e-5): 明示フラグ時のみ外部 egress を遮断する。
// pi の fetch 差し替えより前に install するため、他の import より先に実行する。
// 本番既定 (フラグ未設定) では no-op。
if (process.env.LOAMIUM_BLOCK_EXTERNAL_FETCH === '1') {
  installEgressGuard();
}

const config = configFromEnv();

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`invalid PORT: ${process.env.PORT ?? ''}`);
}

// バインド先。デフォルトはローカルのみ (無認証のため)。LAN 公開は LOAMIUM_HOST=0.0.0.0 で明示的に。
const hostname = process.env.LOAMIUM_HOST ?? '127.0.0.1';

// Sa10026-2: 設定系3系統の一括移行 (冪等・エラーは止まらない)
await runMigration(config);

// インデックスは使い捨て・ファイルが正: 起動時に vault 全走査で構築してから受け付ける
const index = new VaultIndex(config.vaultRoot);
await index.build();

const app = createApp(config, index);

// API 外の変更 (外部エディタ・Git) にも追従する
const watcher = startWatcher(config.vaultRoot, index);

// エージェント定期実行スケジューラ (S2fe109)
const scheduler = startScheduler(config, index);

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  // 実際に listen したポートを記録する。PORT=0 (OS 自動割当) でも
  // localLlmBaseUrl() が正しい shim URL (127.0.0.1:<実ポート>) を導出できるように、
  // 確定ポートを環境変数へ書き戻す (backend=local の pi → shim 接続に必須)。
  process.env.LOAMIUM_ACTUAL_PORT = String(info.port);
  // テスト/CLI がポートを検出できるよう、必ずこの 1 行を出す
  console.log(
    `loamium server listening on http://${info.address}:${info.port} (vault=${config.vaultRoot}, mode=${config.mode}, indexed=${index.size} notes)`,
  );
});

const shutdown = (): void => {
  scheduler.stop();
  void watcher.close().finally(() => {
    server.close(() => process.exit(0));
    // クローズ待ちで固まらないよう保険
    setTimeout(() => process.exit(0), 2000).unref();
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
