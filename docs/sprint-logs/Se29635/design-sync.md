# Sprint Se29635 — Vault 同期 実装設計ノート (canonical)

> ADR-0032 の実装設計。全 Story 実装エージェントはこのノートに従い、module 境界・型・ファイル配置を一致させること。
> 前提: `jq` はこの環境に無い。ROADMAP 編集は main エージェントが node で行う。git は利用可能 (2.43)。

## 原則 (ADR-0032 / VISION / DESIGN_PRINCIPLES)

- 専用同期サーバは作らない。**システム git へシェルアウト**する同期クライアントのみ実装。git は同梱しない。
- git 不在は握りつぶさず **`GitUnavailableError`** で同期機能のみ無効化。**サーバ起動・他機能・テストは壊さない** (ADR-0025 の遅延検出/明示エラー パターン踏襲)。
- 同期エンジンは**差し替え可能な単一モジュール**。シェルアウト層を `interface GitRunner` で抽象化し、テストはこれをスタブ化して決定的に検証。
- **トークンを vault (git 管理下) に絶対保存しない**。`.loamium/` (gitignore 済み) 0600 か環境変数、またはデスクトップ OS キーチェーン。認証は原則 git credential 機構へ委譲、PAT はフォールバック。
- git 作業ツリー直接操作はサービス層 (ADR-0016) を通らない例外 → 同期操作 (commit/pull/push/merge の実行と結果) を `.loamium/audit.log` に記録して補う。
- `.loamium/` は同期対象外 (gitignore 済み) = 端末間で同期されるのはピュア Markdown と assets のみ。

## モジュール配置 `packages/server/src/sync/`

### `git-runner.ts` (Story 1)
```ts
export interface GitResult { code: number; stdout: string; stderr: string; }
export interface GitRunOpts { cwd?: string; timeoutMs?: number; env?: Record<string,string>; }
export interface GitRunner {
  /** git を実行。git バイナリ不在 (ENOENT) は GitUnavailableError を throw。
   *  コマンドの非ゼロ終了は throw せず GitResult.code に載せて返す。 */
  run(args: string[], opts?: GitRunOpts): Promise<GitResult>;
  /** git --version が通るか。結果はキャッシュ可。不在でも throw せず false を返す。 */
  isAvailable(): Promise<boolean>;
}
export class GitUnavailableError extends Error {} // name = 'GitUnavailableError'
export class SystemGitRunner implements GitRunner {} // child_process.spawn('git', args)
```
- 「git 不在」(spawn ENOENT / `git --version` 失敗) と「git コマンド失敗」(clone 済みでない・conflict 等 → 非ゼロ code) を必ず区別する。
- 秘密情報を含む引数 (extraheader の Authorization 等) は stderr/ログにそのまま出さない。

### `sync-config.ts` (Story 2)
- 設定は **`.loamium/sync.json`** (vault 外・gitignore 済み)。`{ enabled, remoteUrl, branch, remoteName, autoSync, debounceMs, pullIntervalMs, deviceName }`。
- PAT フォールバック: `.loamium/sync-credentials.json` に **0600** で保存 (`chmod 0o600`)、または env `LOAMIUM_SYNC_TOKEN`。**vault 配下 / .git/config には絶対書かない**。
- 認証適用: PAT がある場合のみ、push/pull コマンドに **per-command** で `-c http.extraheader=Authorization: Basic base64("x-access-token:"+PAT)` を渡す (disk の .git/config には残さない)。PAT 無しなら git credential helper に委譲 (何も渡さない)。

### `sync-engine.ts` (Story 1 が骨格、Story 2/3/4 が肉付け)
```ts
export interface SyncStatus {
  available: boolean;         // git 利用可
  remoteConfigured: boolean;
  branch: string | null;
  lastSyncAt: string | null;  // ISO
  lastError: string | null;
  ahead: number;              // 未 push commit 数
  behind: number;
  dirty: boolean;             // 未 commit 変更あり
  offline: boolean;
  conflicted: boolean;
  queued: number;             // オフラインキュー件数
}
export interface SyncResult { ok: boolean; pushed: boolean; pulled: boolean; committed: boolean;
  conflicts: string[]; queued: boolean; error?: string; }
export class SyncEngine {
  constructor(opts: { vaultRoot: string; runner: GitRunner; config: SyncConfigStore;
    audit: (entry: Omit<AuditEntry,'ts'>) => Promise<void>; });
  ensureAvailable(): Promise<void>;               // git 不在なら GitUnavailableError
  status(): Promise<SyncStatus>;                   // git 不在なら available:false を返す (throw しない)
  commit(message: string): Promise<boolean>;       // 変更なしは false
  pull(reason: string): Promise<SyncResult>;       // pull --rebase, 非ff/conflict 処理
  push(): Promise<SyncResult>;                     // 失敗時 pull--rebase→再push は syncNow で
  syncNow(): Promise<SyncResult>;                  // ensureAvailable→commit→pull--rebase→push, 各操作 audit
}
```
- `status()` は git 不在時に **throw しない** (`available:false`)。破壊的な `syncNow/pull/push` は `ensureAvailable()` で **GitUnavailableError**。
- commit message 規約: `sync: {deviceName} {ISO8601}`。squash しない。
- 監査: commit/pull/push/merge ごとに `audit({ op:'sync.pull'|'sync.push'|'sync.commit'|'sync.merge', path:'(remote)', mode:'full', result:'ok'|'error'|'denied', status })`。注: `AuditEntry.mode` の許容値は `'full' | 'read-only' | 'append-only'`(`'read-write'` ではない)。Story1 で確認済み。

### `sync-scheduler.ts` (Story 3)
- 編集停止 **debounce (既定 30s, テストは短縮可)** で auto-commit→即 push。アプリ終了/ブラー時にも flush。
- pull トリガ: 起動時 / フォーカス時 / 定期 (既定 10–15 分) / push 拒否時。
- オフラインキュー: network 起因の失敗は握りつぶさず `queued` に積み、接続復帰・次トリガでリトライ。in-memory + `.loamium/sync-queue.json` 永続化。
- vault 変更検知は既存 `VaultIndex.setOnChange` / watcher を利用 (エージェント/API 書き込みも拾う)。自分の pull による変更で無限ループしないよう、pull 中は auto-commit を抑止する guard を持つ。

### `sync-conflict.ts` (Story 4)
- git が自動解決できない競合、および pull で降った変更と **dirty 編集バッファ** の衝突は **`diff3Merge` (@loamium/shared, ADR-0030) を再利用**。
- ファイル競合: `git show :1:path`(base)/`:2:path`(ours)/`:3:path`(theirs) → `diff3Merge(base, ours, theirs)` → 自動統合分を書き戻し、`conflicts[]` があるファイルのみ UI へ。
- UI の dirty バッファ競合は既存 `ConflictResolverDialog` (S2df65d) を再利用。

## REST `packages/server/src/routes/sync.ts` (Story 2 で作成、以降拡張)
| method | path | 用途 |
|---|---|---|
| GET | `/api/sync/status` | SyncStatus |
| GET | `/api/sync/config` | 設定 (token は redact) |
| PUT | `/api/sync/config` | 設定更新 (remoteUrl/branch/autoSync…) |
| POST | `/api/sync/now` | syncNow |
| POST | `/api/sync/pull` | body `{reason}` |
| POST | `/api/sync/push` | push |
| PUT | `/api/sync/credential` | PAT 保存 (0600, vault 外) |
- req/res は zod スキーマ (`packages/shared/src/schemas.ts` に追加、型共有)。書込系なので audit middleware 対象。

## CLI `packages/cli/src/main.ts` (Story 5, REST と 1:1)
`loamium sync status` / `sync now` / `sync config [--remote URL] [--branch B] [--auto <on|off>]` / `sync pull` / `sync push`。

## エージェント (Story 5, CLAUDE.md 規約)
- read: `sync_status` ツール。write モードのみ: `sync_now` ツール。既存 `createVaultReadTools` / write tools 群に追加し、`agent-tools.e2e` の advertised-toolset pin を更新。
- `agent-help.ts` に `sync` トピック追加 (ツール名・入出力・使用例・制約)。
- 機能ガイド `packages/server/src/samples/機能ガイド/Vault同期の使い方.md` を追加し `samples/index.md` にリンク。

## UI `packages/ui/` (Story 4)
- `SyncStatusIndicator.tsx`: 最終同期時刻 / 未 push 件数 / オフライン / 競合 のバッジ + 「今すぐ同期」ボタン。data-testid: `sync-status`, `sync-now-button`, `sync-badge-offline`, `sync-badge-conflict`, `sync-last-time`, `sync-unpushed-count`。
- window focus で `api.syncPull('focus')`。
- **モバイル ≤680px** で崩れないこと (タップターゲット 44px+)。

## テスト方針 (test-discipline)
- Story1: `library` — `sync/*.test.ts` (Vitest) で **スタブ GitRunner** による決定的検証 (GitUnavailableError / commit skip / status など)。
- Story2/3: `api` — `tests/acceptance/sync-*.spec.ts`。**実 system git + ローカル bare リポジトリ (temp)** を remote にして push/pull 往復を検証 (real-mode、mock 禁止)。helper は `tests/acceptance/helpers/server.js` の `startServer/makeTempVault` を利用。
- Story4: `gui` — Playwright `packages/ui/tests/e2e/sync-status.e2e.spec.ts` (実バックエンド) + `sync-status.mock.spec.ts` (error/edge)。
- Story5: `cli` — `tests/acceptance/sync-cli.spec.ts` (実バイナリ subprocess) + agent-tools.e2e pin 更新 + audit.log 検証 + ガイド存在/リンク検証。
- Guard8: このプロジェクトの guard8 data_paths は Go 用既定 (`internal/…`) で該当なし → **n/a**。ただし同期はデータ経路なので、往復での**バイト一致検証** (push→別クローンで pull→同一内容) と**競合で編集喪失しない**検証を Story2/4 の acceptance に必ず含める (Rule 8 の精神を TS で満たす)。
