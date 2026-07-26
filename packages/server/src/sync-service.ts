/**
 * 同期サービスファクトリ (ADR-0032 / Se29635-2/3)。
 *
 * `createSyncService` は `SyncEngine` / `SyncConfigStore` / `SyncScheduler` を
 * 一か所で構築し、`app.ts` と `index.ts` が同一インスタンスを共有できるようにする。
 *
 * `getSyncService` はモジュールレベルの Map でインスタンスをキャッシュし、
 * vaultRoot ごとに 1 インスタンスだけを保持する (Se29635-5)。
 * REST/scheduler とエージェントツールが同一エンジンを共有することで runtime 状態が一致する。
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
import { InitialLinker, type InitialLinkerOpts } from './sync/link.js';
import { writeAuditEntry } from './audit.js';
import type { ServerConfig } from './config.js';

/** vaultRoot → SyncService のモジュールキャッシュ (Se29635-5 shared single engine) */
const _syncServiceCache = new Map<string, SyncService>();

/** `createSyncService` が返すサービスオブジェクト。 */
export interface SyncService {
  engine: SyncEngine;
  store: SyncConfigStore;
  /** Story 3: debounce / 定期 pull / flush を管理するスケジューラ。 */
  scheduler: SyncScheduler;
  /** Story 4 (Sf17a4c-4): 初回リンク状態機械。REST / CLI が共有する単一インスタンス。 */
  linker: InitialLinker;
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

  /** 共通監査コールバック — `ts` を補完して writeAuditEntry に渡す。 */
  function auditCallback(
    entry: Parameters<InitialLinkerOpts['audit']>[0],
  ): Promise<void> {
    return writeAuditEntry(config, { ...entry, ts: new Date().toISOString() });
  }

  const engine = new SyncEngine({
    vaultRoot: config.vaultRoot,
    runner,
    getConfig: () => store.load(),
    getToken: () => store.getToken(),
    audit: auditCallback,
  });
  const linker = new InitialLinker({
    vaultRoot: config.vaultRoot,
    runner,
    audit: auditCallback,
  });
  const scheduler = new SyncScheduler({ engine, store });
  return { engine, store, scheduler, linker };
}

/**
 * vaultRoot ごとにキャッシュされた SyncService を返す (Se29635-5)。
 *
 * REST ルート / スケジューラ / エージェントツールが同一エンジンインスタンスを共有し、
 * offline/lastSyncAt/queued などの runtime 状態が一致することを保証する。
 * `createSyncService` はコンストラクタのまま維持し、テストで直接呼ぶ際に使う。
 */
export function getSyncService(config: ServerConfig): SyncService {
  const key = config.vaultRoot;
  const cached = _syncServiceCache.get(key);
  if (cached !== undefined) return cached;
  const service = createSyncService(config);
  _syncServiceCache.set(key, service);
  return service;
}
