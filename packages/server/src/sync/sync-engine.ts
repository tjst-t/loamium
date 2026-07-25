/**
 * Vault 同期エンジン (ADR-0032 / Se29635-1 骨格、Story 2/3/4 で肉付け)。
 *
 * システム git にシェルアウトして commit / pull / push / status を提供する。
 * シェルアウト層 `GitRunner` をコンストラクタ注入で受け取るため、テストは
 * スタブを差し込んで決定的に検証できる。
 *
 * ## git 不在時の挙動 (ADR-0025 パターン踏襲)
 * - `status()` は git 不在でも throw せず `available:false` を返す (サーバ起動を壊さない)。
 * - `syncNow()` / `pull()` / `push()` / `commit()` は `ensureAvailable()` を通す
 *   ため git 不在なら `GitUnavailableError` を throw する (握りつぶし禁止)。
 *
 * ## 監査
 * commit/pull/push ごとに audit コールバックへエントリを渡す。
 * HTTP ミドルウェアを通らない直接 git 操作の補填 (design-sync.md 参照)。
 */
import type { AuditEntry } from '@loamium/shared';
import { GitUnavailableError, redactGitSecrets } from './git-runner.js';
import type { GitRunner } from './git-runner.js';

// ──────────────────────────────────────────────
// 設定型 (Story 2 が SyncConfigStore で置き換える)
// ──────────────────────────────────────────────

/**
 * 同期エンジンが読み取る設定のスナップショット型。
 * Story 2 で `.loamium/sync.json` を読む `SyncConfigStore` に差し替える想定。
 * Story 1 ではコンストラクタに `getConfig` ゲッタを渡す形で抽象化する。
 */
export interface SyncEngineConfig {
  /** 同期機能の有効/無効フラグ。 */
  enabled: boolean;
  /** リモート URL (null なら未設定)。 */
  remoteUrl: string | null;
  /** 同期対象ブランチ名 (既定 'main')。 */
  branch: string;
  /** リモート名 (既定 'origin')。 */
  remoteName: string;
  /** 端末識別名。commit メッセージに付与する。 */
  deviceName: string;
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/**
 * `SyncEngine.status()` が返す同期状態のスナップショット。
 * git 不在時は `available:false` で残フィールドをゼロ値にする。
 */
export interface SyncStatus {
  /** git バイナリが利用可能かどうか。 */
  available: boolean;
  /** リモートが設定されているかどうか (remoteUrl !== null)。 */
  remoteConfigured: boolean;
  /** 現在のブランチ名。git 不在や未初期化では null。 */
  branch: string | null;
  /** 最終同期時刻 (ISO 8601)。Story 2 でストアから読む。現在は null。 */
  lastSyncAt: string | null;
  /** 最後に発生したエラーメッセージ。 */
  lastError: string | null;
  /** リモートより先行している commit 数 (未 push)。 */
  ahead: number;
  /** リモートより遅れている commit 数 (未 pull)。 */
  behind: number;
  /** 未 commit の変更が存在するか (ワーキングツリーが dirty)。 */
  dirty: boolean;
  /** オフライン状態かどうか (Story 3 で判定を充実させる)。 */
  offline: boolean;
  /** 競合状態かどうか。 */
  conflicted: boolean;
  /** オフラインキューに積まれた件数 (Story 3 が実装)。 */
  queued: number;
}

/**
 * `commit()` / `pull()` / `push()` / `syncNow()` が返す実行結果。
 * エラーは throw せず `error` フィールドに詰めて返す (ネットワーク起因等)。
 * ただし git 不在 (`GitUnavailableError`) は呼び出し元まで throw する。
 */
export interface SyncResult {
  /** 全体として成功したか。 */
  ok: boolean;
  /** push が成功したか。 */
  pushed: boolean;
  /** pull が行われたか。 */
  pulled: boolean;
  /** commit が行われたか (変更なし skip は false)。 */
  committed: boolean;
  /** 競合ファイルのパス一覧 (空配列 = 競合なし)。 */
  conflicts: string[];
  /** オフラインキューに積んだか (Story 3 が実装)。 */
  queued: boolean;
  /**
   * エラーメッセージ。ok=false のときのみ設定される。
   * exactOptionalPropertyTypes: true のためキー自体を省略して undefined を表す。
   */
  error?: string;
}

// ──────────────────────────────────────────────
// SyncEngine コンストラクタオプション
// ──────────────────────────────────────────────

export interface SyncEngineOpts {
  /** vault のルートパス (絶対パス)。 */
  vaultRoot: string;
  /** git シェルアウト実装。テストはスタブを渡す。 */
  runner: GitRunner;
  /** 設定スナップショットを返すゲッタ (Story 2 が SyncConfigStore に差し替える)。 */
  getConfig: () => SyncEngineConfig;
  /**
   * 監査エントリを書き込むコールバック。
   * `writeAuditEntry(config, { ts, ...entry })` に相当する薄いラッパーを渡す。
   * HTTP ミドルウェアを通らない git 操作の補填として各操作で呼ぶ。
   */
  audit: (entry: Omit<AuditEntry, 'ts'>) => Promise<void>;
}

// ──────────────────────────────────────────────
// SyncEngine
// ──────────────────────────────────────────────

/**
 * Vault 同期エンジン本体。
 *
 * 使い方:
 * ```ts
 * const engine = new SyncEngine({ vaultRoot, runner, getConfig, audit });
 * const status = await engine.status();   // git 不在でも throw しない
 * await engine.syncNow();                  // git 不在なら GitUnavailableError
 * ```
 */
export class SyncEngine {
  readonly #vaultRoot: string;
  readonly #runner: GitRunner;
  readonly #getConfig: () => SyncEngineConfig;
  readonly #audit: (entry: Omit<AuditEntry, 'ts'>) => Promise<void>;

  constructor(opts: SyncEngineOpts) {
    this.#vaultRoot = opts.vaultRoot;
    this.#runner = opts.runner;
    this.#getConfig = opts.getConfig;
    this.#audit = opts.audit;
  }

  // ──────────────────────────────────────────
  // 内部ヘルパ
  // ──────────────────────────────────────────

  /** git コマンドを vault ルートで実行する共通ラッパ。 */
  #run(args: string[]): ReturnType<GitRunner['run']> {
    return this.#runner.run(args, { cwd: this.#vaultRoot });
  }

  /** `git status --porcelain=v2 --branch` をパースして ahead/behind/dirty を返す。 */
  async #parseStatus(): Promise<{ branch: string | null; ahead: number; behind: number; dirty: boolean; conflicted: boolean }> {
    const result = await this.#run(['status', '--porcelain=v2', '--branch']);
    if (result.code !== 0) {
      // 初期化されていないリポジトリ等
      return { branch: null, ahead: 0, behind: 0, dirty: false, conflicted: false };
    }

    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    let dirty = false;
    let conflicted = false;

    for (const line of result.stdout.split('\n')) {
      // ブランチ名: "# branch.head <name>" or "(detached)"
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim();
        branch = head === '(detached)' ? null : head;
      }
      // ahead/behind: "# branch.ab +<ahead> -<behind>"
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(line);
        if (m) {
          ahead = parseInt(m[1]!, 10);
          behind = parseInt(m[2]!, 10);
        }
      }
      // 通常変更: 行頭が "1" or "2" (changed/renamed)
      else if (/^[12] /.test(line)) {
        dirty = true;
      }
      // 未追跡: "?"
      else if (line.startsWith('? ')) {
        dirty = true;
      }
      // 競合: "u "
      else if (line.startsWith('u ')) {
        dirty = true;
        conflicted = true;
      }
    }

    return { branch, ahead, behind, dirty, conflicted };
  }

  // ──────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────

  /**
   * git が利用可能でなければ `GitUnavailableError` を throw する。
   * 破壊的操作 (syncNow/pull/push/commit) の冒頭で呼ぶ。
   */
  async ensureAvailable(): Promise<void> {
    const ok = await this.#runner.isAvailable();
    if (!ok) {
      throw new GitUnavailableError('git is not available on this system; sync is disabled');
    }
  }

  /**
   * 現在の同期状態を返す。
   * git 不在でも **throw しない** — `available:false` を返す。
   * サーバ起動・他機能・テストを壊さないための graceful surface。
   */
  async status(): Promise<SyncStatus> {
    const isAvail = await this.#runner.isAvailable();
    const config = this.#getConfig();

    if (!isAvail) {
      return {
        available: false,
        remoteConfigured: false,
        branch: null,
        lastSyncAt: null,
        lastError: null,
        ahead: 0,
        behind: 0,
        dirty: false,
        offline: false,
        conflicted: false,
        queued: 0,
      };
    }

    try {
      const { branch, ahead, behind, dirty, conflicted } = await this.#parseStatus();
      return {
        available: true,
        remoteConfigured: config.remoteUrl !== null,
        branch,
        lastSyncAt: null,       // Story 2 で config ストアから読む
        lastError: null,
        ahead,
        behind,
        dirty,
        offline: false,         // Story 3 が実装
        conflicted,
        queued: 0,              // Story 3 が実装
      };
    } catch {
      // git コマンド失敗でも throw しない
      return {
        available: true,
        remoteConfigured: config.remoteUrl !== null,
        branch: null,
        lastSyncAt: null,
        lastError: 'Failed to parse git status',
        ahead: 0,
        behind: 0,
        dirty: false,
        offline: false,
        conflicted: false,
        queued: 0,
      };
    }
  }

  /**
   * ワーキングツリーの変更を commit する。
   * - 変更なし (クリーンツリー) の場合は commit をスキップして `false` を返す。
   * - 変更あり → `git add -A` → `git commit -m message` → `true` を返す。
   * - 監査: `sync.commit` を記録する。
   */
  async commit(message: string): Promise<boolean> {
    await this.ensureAvailable();

    // クリーンツリーチェック: `git status --porcelain` が空なら何もしない
    const statusResult = await this.#run(['status', '--porcelain']);
    if (statusResult.code !== 0) {
      throw new Error(`git status failed: ${redactGitSecrets(statusResult.stderr)}`);
    }
    if (statusResult.stdout.trim() === '') {
      // クリーンツリー — 空 commit は作らない
      return false;
    }

    // git add -A
    const addResult = await this.#run(['add', '-A']);
    if (addResult.code !== 0) {
      await this.#audit({
        op: 'sync.commit',
        path: '(vault)',
        mode: 'full',
        result: 'error',
        status: addResult.code,
      });
      throw new Error(`git add -A failed (code ${addResult.code}): ${redactGitSecrets(addResult.stderr)}`);
    }

    // git commit -m "message"
    const commitResult = await this.#run(['commit', '-m', message]);
    if (commitResult.code !== 0) {
      await this.#audit({
        op: 'sync.commit',
        path: '(vault)',
        mode: 'full',
        result: 'error',
        status: commitResult.code,
      });
      throw new Error(`git commit failed (code ${commitResult.code}): ${redactGitSecrets(commitResult.stderr)}`);
    }

    await this.#audit({
      op: 'sync.commit',
      path: '(vault)',
      mode: 'full',
      result: 'ok',
      status: 0,
    });

    return true;
  }

  /**
   * `git pull --rebase` を実行する。
   * - 競合が発生した場合は競合ファイル一覧を `SyncResult.conflicts` に詰めて返す。
   * - Story 4 が競合解消を充実させる。ここでは競合ファイルを返すだけ。
   * - 監査: `sync.pull` を記録する。
   */
  async pull(reason: string): Promise<SyncResult> {
    await this.ensureAvailable();

    const pullResult = await this.#run(['pull', '--rebase']);
    const ok = pullResult.code === 0;
    let conflicts: string[] = [];

    if (!ok) {
      // 競合ファイル一覧を取得 (rebase 競合 → U=unmerged)
      const conflictResult = await this.#run(['diff', '--name-only', '--diff-filter=U']);
      if (conflictResult.code === 0 && conflictResult.stdout.trim() !== '') {
        conflicts = conflictResult.stdout
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      }
    }

    await this.#audit({
      op: 'sync.pull',
      path: `(remote) reason=${reason}`,
      mode: 'full',
      result: ok ? 'ok' : 'error',
      status: pullResult.code,
    });

    return {
      ok,
      pushed: false,
      pulled: ok,
      committed: false,
      conflicts,
      queued: false,
      ...(ok ? {} : { error: redactGitSecrets(pullResult.stderr) || `git pull exited with code ${pullResult.code}` }),
    };
  }

  /**
   * `git push` を実行する。
   * - 監査: `sync.push` を記録する。
   */
  async push(): Promise<SyncResult> {
    await this.ensureAvailable();

    const pushResult = await this.#run(['push']);
    const ok = pushResult.code === 0;

    await this.#audit({
      op: 'sync.push',
      path: '(remote)',
      mode: 'full',
      result: ok ? 'ok' : 'error',
      status: pushResult.code,
    });

    return {
      ok,
      pushed: ok,
      pulled: false,
      committed: false,
      conflicts: [],
      queued: false,
      ...(ok ? {} : { error: redactGitSecrets(pushResult.stderr) || `git push exited with code ${pushResult.code}` }),
    };
  }

  /**
   * 完全同期 (commit → pull --rebase → push) を実行する。
   *
   * 実行順序:
   * 1. `ensureAvailable()` — git 不在なら `GitUnavailableError` を throw。
   * 2. `commit(規約メッセージ)` — 変更があれば commit。
   * 3. `pull('manual')` — rebase で pull。
   * 4. `push()` — push。
   *
   * ネットワーク起因のエラーは throw せず `SyncResult.error` に詰めて返す。
   * Story 3 がオフラインキューを実装するまでの暫定実装。
   */
  async syncNow(): Promise<SyncResult> {
    // git 不在なら GitUnavailableError を throw (握りつぶし禁止)
    await this.ensureAvailable();

    const config = this.#getConfig();
    const iso = new Date().toISOString();
    const commitMsg = `sync: ${config.deviceName} ${iso}`;

    let committed = false;
    let pulled = false;
    let pushed = false;
    let conflicts: string[] = [];
    let firstError: string | undefined;

    // Step 1: commit
    try {
      committed = await this.commit(commitMsg);
    } catch (err) {
      // commit 失敗なら pull/push もスキップして error を返す (下の !firstError ガード)。
      // Story 3 で「commit 失敗でも remote 変更は pull する」挙動を検討する余地あり。
      firstError = redactGitSecrets(String(err));
    }

    // Step 2: pull
    if (!firstError) {
      try {
        const pullRes = await this.pull('manual');
        pulled = pullRes.pulled;
        conflicts = pullRes.conflicts;
        if (!pullRes.ok && pullRes.error) {
          firstError = pullRes.error;
        }
      } catch (err) {
        firstError = String(err);
      }
    }

    // Step 3: push
    if (!firstError) {
      try {
        const pushRes = await this.push();
        pushed = pushRes.pushed;
        if (!pushRes.ok && pushRes.error) {
          firstError = pushRes.error;
        }
      } catch (err) {
        firstError = String(err);
      }
    }

    const ok = !firstError && conflicts.length === 0;
    return {
      ok,
      pushed,
      pulled,
      committed,
      conflicts,
      queued: false,       // Story 3 が実装
      ...(firstError !== undefined ? { error: firstError } : {}),
    };
  }
}
