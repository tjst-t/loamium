/**
 * sync/ モジュール公開面バレル (Se29635)。
 *
 * Story 1: git-runner + sync-engine の公開 API を re-export する。
 * Story 2 以降: sync-config, sync-scheduler, sync-conflict が追加される。
 */

// git-runner
export type { GitResult, GitRunOpts, GitRunner } from './git-runner.js';
export { GitUnavailableError, SystemGitRunner } from './git-runner.js';

// sync-engine
export type { SyncEngineConfig, SyncEngineOpts, SyncStatus, SyncResult } from './sync-engine.js';
export { SyncEngine } from './sync-engine.js';
