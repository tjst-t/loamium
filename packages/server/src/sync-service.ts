/**
 * 同期サービスファクトリ (ADR-0032 / Se29635-2/3)。
 *
 * `createSyncService` は `SyncEngine` / `SyncConfigStore` / `SyncScheduler` を
 * 一か所で構築し、`app.ts` と `index.ts` が同一インスタンスを共有できるようにする。
 *
 * ## 依存関係
 * - `SystemGitRunner` — システム git にシェルアウト。
 * - `SyncConfigStore` — `.loamium/sync.json` / `sync-credentials.json` の読み書き。
 * - `SyncEngine` — commit / pull / push / autoSyncOnce / retryIfPending / status の実装。
 * - `SyncScheduler` — debounce auto-commit / 定期 pull / flush を管理する。
 * - `writeAuditEntry` — git 直接操作の補填監査ログ。
 */
import { SystemGitRunner } from './sync/git-runner.js';
import { SyncEngine } from './sync/sync-engine.js';
import { SyncConfigStore } from './sync/sync-config.js';
import { SyncScheduler } from './sync/sync-scheduler.js';
import { writeAuditEntry } from './audit.js';
import type { ServerConfig } from './config.js';

/** `createSyncService` が返すサービスオブジェクト。 */
export interface SyncService {
  engine: SyncEngine;
  store: SyncConfigStore;
  /** Story 3: debounce / 定期 pull / flush を管理するスケジューラ。 */
  scheduler: SyncScheduler;
}

/**
 * 同期エンジン・設定ストア・スケジューラを構築して返す。
 *
 * - `store.load()` を `getConfig` ゲッタとして注入 → 設定変更が即座に反映される。
 * - `store.getToken()` を `getToken` ゲッタとして注入 → PAT が常に最新。
 * - 監査コールバックは `writeAuditEntry(config, ...)` に `ts` を補完して渡す。
 * - `scheduler` は `index.ts` が `start()` を呼んで起動する。
 */
export function createSyncService(config: ServerConfig): SyncService {
  const runner = new SystemGitRunner();
  const store = new SyncConfigStore(config.vaultRoot);
  const engine = new SyncEngine({
    vaultRoot: config.vaultRoot,
    runner,
    getConfig: () => store.load(),
    getToken: () => store.getToken(),
    audit: (entry) =>
      writeAuditEntry(config, { ...entry, ts: new Date().toISOString() }),
  });
  const scheduler = new SyncScheduler({ engine, store });
  return { engine, store, scheduler };
}
