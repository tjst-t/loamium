/**
 * sync/ モジュール公開面バレル (Se29635)。
 *
 * Story 1: git-runner + sync-engine の公開 API を re-export する。
 * Story 2: sync-config (SyncConfigStore) を追加。
 * Story 3 以降: sync-scheduler, sync-conflict が追加される。
 */

// git-runner
export type { GitResult, GitRunOpts, GitRunner } from './git-runner.js';
export { GitUnavailableError, SystemGitRunner, redactGitSecrets } from './git-runner.js';

// sync-engine
export type { SyncEngineConfig, SyncEngineOpts, SyncStatus, SyncResult } from './sync-engine.js';
export { SyncEngine } from './sync-engine.js';

// sync-config (Story 2)
export type { SyncConfig } from './sync-config.js';
export { SyncConfigStore } from './sync-config.js';

// link — 初回リンク状態機械 (Sf17a4c-1)
export type {
  RemoteState,
  ProbeResult,
  LocalState,
  LinkResult,
  InitialLinkerOpts,
} from './link.js';
export { InitialLinker } from './link.js';
