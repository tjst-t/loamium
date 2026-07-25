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
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
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
   * PAT トークンを返すコールバック (Story 2 が SyncConfigStore.getToken に差し替える)。
   * トークンがない場合は null を返す — git credential helper に委譲する。
   * 省略時は常に null (後方互換: Story 1 のテストは渡さなくてよい)。
   */
  getToken?: () => string | null;
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
/**
 * リトライ可能なリモートエラーのパターン (ネットワーク起因)。
 * 認証失敗等の非リトライエラーはここに含めない。
 */
const RETRYABLE_PATTERNS = [
  'could not read from remote',
  'unable to access',
  'could not resolve host',
  'connection refused',
  'does not appear to be a git repository',
  'failed to connect',
] as const;

/**
 * git の stderr がリトライ可能なリモートエラーを示すか判定する。
 * ネットワーク/到達不能起因のエラーのみ true を返す。
 */
export function isRetryableRemoteError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => lower.includes(p));
}

export class SyncEngine {
  readonly #vaultRoot: string;
  readonly #runner: GitRunner;
  readonly #getConfig: () => SyncEngineConfig;
  readonly #getToken: () => string | null;
  readonly #audit: (entry: Omit<AuditEntry, 'ts'>) => Promise<void>;

  // ── Story 3 ランタイム状態 ──────────────────────
  /** 最後に push/syncNow が成功した時刻 (ISO 8601)。 */
  #lastSyncAt: string | null = null;
  /** 最後に発生したエラーメッセージ (redact 済み)。 */
  #lastError: string | null = null;
  /** リトライ可能なリモートエラーにより、commit がローカルにキューされている状態。 */
  #offline = false;

  constructor(opts: SyncEngineOpts) {
    this.#vaultRoot = opts.vaultRoot;
    this.#runner = opts.runner;
    this.#getConfig = opts.getConfig;
    this.#getToken = opts.getToken ?? (() => null);
    this.#audit = opts.audit;
  }

  // ──────────────────────────────────────────
  // 内部ヘルパ
  // ──────────────────────────────────────────

  /** git コマンドを vault ルートで実行する共通ラッパ。 */
  #run(args: string[]): ReturnType<GitRunner['run']> {
    return this.#runner.run(args, { cwd: this.#vaultRoot });
  }

  /**
   * PAT トークンを per-command の http.extraheader として付与した git コマンドを実行する。
   * push / pull など外部通信を伴うコマンドにのみ使う。
   *
   * PAT がない場合は extraheader を付けずに実行し、git credential helper に委譲する。
   * トークンはログ/stderr に出ないよう redactGitSecrets でガードする。
   * また `-c http.extraheader=...` 引数自体もログに出さないため、
   * ラッパー内で処理し呼び出し元には漏れない。
   */
  #runWithAuth(args: string[]): ReturnType<GitRunner['run']> {
    const token = this.#getToken();
    if (!token) {
      // PAT なし → git credential helper に委譲 (引数は渡さない)
      return this.#runner.run(args, { cwd: this.#vaultRoot });
    }
    // Basic 認証: x-access-token:{PAT} を Base64 エンコード
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    const authArgs = ['-c', `http.extraheader=Authorization: Basic ${encoded}`, ...args];
    return this.#runner.run(authArgs, { cwd: this.#vaultRoot });
  }

  /**
   * `git rev-list --count HEAD ^<remoteName>/<branch>` でローカルの未 push commit 数を返す。
   *
   * `git status --porcelain=v2` の `branch.ab` はトラッキング設定がない場合に
   * 表示されない (`git push --set-upstream` 不使用時など)。このメソッドで補完する。
   * リモート ref が存在しない場合 (初回 push 前・リモート到達不能後) は 0 を返す。
   */
  async #countAheadRevs(): Promise<number> {
    const config = this.#getConfig();
    const remoteRef = `${config.remoteName}/${config.branch}`;
    // git rev-list --count HEAD ^origin/main: 未 push commit 数
    const result = await this.#run(['rev-list', '--count', 'HEAD', `^${remoteRef}`]);
    if (result.code !== 0) {
      // リモート ref が存在しない (初回 push 前・fetch 未実施・リモート到達不能後):
      // まだ一度も push できていない = ローカル全 commit が未 push とみなし、
      // HEAD 到達可能な commit 総数を返す (offline 時に queued=0 と誤表示しないため。
      // review Se29635-3 Finding 4)。
      const all = await this.#run(['rev-list', '--count', 'HEAD']);
      if (all.code !== 0) return 0; // リポジトリ未初期化等
      const total = parseInt(all.stdout.trim(), 10);
      return Number.isFinite(total) ? total : 0;
    }
    const n = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
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
      const { branch, ahead: aheadGit, behind, dirty, conflicted } = await this.#parseStatus();
      // Story 3: オフライン時は未 push commit 数をキュー件数として報告する。
      // `git status --porcelain=v2` の branch.ab はトラッキング設定がない場合に
      // 表示されないため、オフライン時は git rev-list で正確なカウントを補完する。
      let ahead = aheadGit;
      let queued = 0;
      if (this.#offline) {
        const aheadRevs = await this.#countAheadRevs();
        // rev-list が 0 かつ git status も 0 なら本当に 0 (まれに fetch 不足で 0 になる場合がある)
        ahead = Math.max(aheadGit, aheadRevs);
        queued = ahead;
      }
      return {
        available: true,
        remoteConfigured: config.remoteUrl !== null,
        branch,
        lastSyncAt: this.#lastSyncAt,
        lastError: this.#lastError,
        ahead,
        behind,
        dirty,
        offline: this.#offline,
        conflicted,
        queued,
      };
    } catch {
      // git コマンド失敗でも throw しない
      return {
        available: true,
        remoteConfigured: config.remoteUrl !== null,
        branch: null,
        lastSyncAt: this.#lastSyncAt,
        lastError: this.#lastError ?? 'Failed to parse git status',
        ahead: 0,
        behind: 0,
        dirty: false,
        offline: this.#offline,
        conflicted: false,
        queued: 0,
      };
    }
  }

  /**
   * `.loamium/` が vault の .gitignore で無視されていることを保証する (無ければ追記)。
   *
   * `git add -A` が `.loamium/` 配下 (audit.log / sync.json / **PAT を含む
   * sync-credentials.json**) を誤ってステージし、秘密情報を commit/push するのを防ぐ
   * (ADR-0032 / DESIGN_PRINCIPLES priority 2 データ安全性)。冪等。
   */
  async #ensureLoamiumIgnored(): Promise<void> {
    // `git check-ignore -q .loamium` は無視されていれば code 0 を返す
    const check = await this.#run(['check-ignore', '-q', '.loamium']);
    if (check.code === 0) return;

    const gitignorePath = path.join(this.#vaultRoot, '.gitignore');
    let existing = '';
    try {
      existing = await readFile(gitignorePath, 'utf8');
    } catch {
      existing = ''; // 未作成 → 新規作成する
    }
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    await appendFile(gitignorePath, `${needsLeadingNewline ? '\n' : ''}.loamium/\n`, 'utf8');
  }

  /**
   * ワーキングツリーの変更を commit する。
   * - 変更なし (クリーンツリー) の場合は commit をスキップして `false` を返す。
   * - 変更あり → `.loamium/` 無視を保証 → `git add -A` → `git commit -m message` → `true`。
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

    // 秘密情報 (.loamium/ 配下) を誤ってステージしないよう、add -A の前に無視を保証する
    await this.#ensureLoamiumIgnored();

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

    // F-3: config の remoteName / branch を明示指定して pull する
    const config = this.#getConfig();
    const pullResult = await this.#runWithAuth([
      'pull', '--rebase', config.remoteName, config.branch,
    ]);
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

    // F-3: config の remoteName / branch を明示して push する。
    // `HEAD:<branch>` refspec により upstream 追跡設定の有無にかかわらず動作する。
    const config = this.#getConfig();
    const pushResult = await this.#runWithAuth([
      'push', config.remoteName, `HEAD:${config.branch}`,
    ]);
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
   * vault の git リポジトリにリモート設定を適用する。
   *
   * - `config.remoteUrl` が null の場合は何もしない。
   * - リモートが存在しない場合は `git remote add` で追加する。
   * - リモートが存在する場合は `git remote set-url` で URL を更新する。
   * - URL (トークンなし) を `.git/config` に書くことは設計上許容されている。
   *   トークンは per-command の extraheader で渡し、`.git/config` には書かない。
   * - 設定保存時に呼ぶことで起動前に確定したリモートを保持する。
   */
  async configureRemote(): Promise<void> {
    await this.ensureAvailable();

    // 設定時に `.loamium/` 無視を先回りで保証する (秘密情報の混入防止・冪等)
    await this.#ensureLoamiumIgnored();

    const config = this.#getConfig();
    if (!config.remoteUrl) {
      return; // リモート URL 未設定 → 何もしない
    }

    // 既存リモートの確認
    const listResult = await this.#run(['remote', 'get-url', config.remoteName]);
    if (listResult.code === 0) {
      // リモートが存在する → URL を更新
      const setResult = await this.#run([
        'remote', 'set-url', config.remoteName, config.remoteUrl,
      ]);
      if (setResult.code !== 0) {
        throw new Error(
          `git remote set-url failed (code ${setResult.code}): ${redactGitSecrets(setResult.stderr)}`,
        );
      }
    } else {
      // リモートが存在しない → 追加
      const addResult = await this.#run([
        'remote', 'add', config.remoteName, config.remoteUrl,
      ]);
      if (addResult.code !== 0) {
        throw new Error(
          `git remote add failed (code ${addResult.code}): ${redactGitSecrets(addResult.stderr)}`,
        );
      }
    }
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
        firstError = redactGitSecrets(String(err));
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
        firstError = redactGitSecrets(String(err));
      }
    }

    const ok = !firstError && conflicts.length === 0;
    // Story 3: ランタイム状態を更新する
    if (ok) {
      this.#lastSyncAt = new Date().toISOString();
      this.#offline = false;
      this.#lastError = null;
    } else if (firstError !== undefined) {
      this.#lastError = firstError;
      // リトライ可能なリモートエラー (ネットワーク起因) はオフラインとしてマークする
      if (isRetryableRemoteError(firstError)) {
        this.#offline = true;
      }
    }
    const queued = this.#offline;
    return {
      ok,
      pushed,
      pulled,
      committed,
      conflicts,
      queued,
      ...(firstError !== undefined ? { error: firstError } : {}),
    };
  }

  // ──────────────────────────────────────────
  // Story 3: 自動同期 API
  // ──────────────────────────────────────────

  /**
   * デバウンスターゲット: dirty なら commit → push する。
   *
   * - push が non-ff で失敗した場合は pull --rebase してリトライする (AC-3-2 push 拒否時 pull)。
   * - リトライ可能なリモートエラーの場合は `#offline=true` をセットし、
   *   ローカル commit (未 push) をキューとして保持する (AC-3-3 オフラインキュー)。
   * - 成功時は `#lastSyncAt`, `#offline=false`, `#lastError=null` を更新する。
   */
  async autoSyncOnce(): Promise<SyncResult> {
    await this.ensureAvailable();

    const config = this.#getConfig();
    const iso = new Date().toISOString();
    const commitMsg = `sync: ${config.deviceName} ${iso}`;

    let committed = false;
    let pulled = false;
    let pushed = false;
    let conflicts: string[] = [];
    let firstError: string | undefined;

    // Step 1: dirty なら commit する (クリーンなら false を返す = スキップ)
    try {
      committed = await this.commit(commitMsg);
    } catch (err) {
      firstError = redactGitSecrets(String(err));
    }

    // Step 2: push を試みる
    if (!firstError) {
      try {
        const pushRes = await this.push();
        if (pushRes.ok) {
          pushed = true;
        } else {
          // push 失敗 — non-ff か、ネットワーク起因かを判別する
          const stderr = pushRes.error ?? '';
          const isNonFf =
            stderr.includes('rejected') ||
            stderr.includes('non-fast-forward') ||
            stderr.includes('[rejected]');

          if (isNonFf) {
            // push 拒否 → pull --rebase してからリトライする (AC-3-2)
            const pullRes = await this.pull('push-reject');
            pulled = pullRes.pulled;
            conflicts = pullRes.conflicts;
            if (pullRes.ok) {
              // rebase 成功 → push リトライ
              const retryPush = await this.push();
              pushed = retryPush.pushed;
              if (!retryPush.ok && retryPush.error) {
                firstError = retryPush.error;
              }
            } else {
              // pull 失敗 (error は pull() が必ず埋めるが、型上 optional のため保険)
              firstError = pullRes.error ?? 'push-reject 後の pull --rebase に失敗';
            }
          } else if (isRetryableRemoteError(stderr)) {
            // ネットワーク/到達不能 → オフラインとしてキューに積む (AC-3-3)
            this.#offline = true;
            this.#lastError = stderr;
            return {
              ok: false,
              pushed: false,
              pulled: false,
              committed,
              conflicts: [],
              queued: true,
              error: stderr,
            };
          } else {
            // 非リトライエラー (認証失敗等)
            firstError = stderr;
          }
        }
      } catch (err) {
        firstError = redactGitSecrets(String(err));
      }
    }

    const ok = !firstError && conflicts.length === 0;
    if (ok && pushed) {
      this.#lastSyncAt = new Date().toISOString();
      this.#offline = false;
      this.#lastError = null;
    } else if (firstError !== undefined) {
      // リトライ可能なエラーならオフラインとしてマークする
      if (isRetryableRemoteError(firstError)) {
        this.#offline = true;
      }
      this.#lastError = firstError;
    }

    return {
      ok,
      pushed,
      pulled,
      committed,
      conflicts,
      queued: this.#offline,
      ...(firstError !== undefined ? { error: firstError } : {}),
    };
  }

  /**
   * オフライン状態で未 push commit がある場合に push を再試行する。
   *
   * - `#offline=true` かつ ahead>0 でなければ null を返す (何もしない)。
   * - 成功時は `#offline=false`, `#lastSyncAt` を更新し、結果を返す。
   * - 失敗時もエラーを飲み込まず `#lastError` に残す。
   */
  async retryIfPending(): Promise<SyncResult | null> {
    // git 不在は呼び出し元が別途保護する (ここでは graceful に null 返し)
    const isAvail = await this.#runner.isAvailable();
    if (!isAvail) return null;

    if (!this.#offline) return null;

    const { ahead } = await this.#parseStatus();
    if (ahead === 0) {
      // キューが空 → オフライン状態を解除して null を返す
      this.#offline = false;
      return null;
    }

    // push を再試行する
    try {
      const pushRes = await this.push();
      if (pushRes.ok) {
        this.#lastSyncAt = new Date().toISOString();
        this.#offline = false;
        this.#lastError = null;
        return { ...pushRes, queued: false };
      } else {
        const stderr = pushRes.error ?? '';
        this.#lastError = stderr;
        // まだオフラインのままにしておく
        return { ...pushRes, queued: true };
      }
    } catch (err) {
      const msg = redactGitSecrets(String(err));
      this.#lastError = msg;
      return {
        ok: false,
        pushed: false,
        pulled: false,
        committed: false,
        conflicts: [],
        queued: true,
        error: msg,
      };
    }
  }
}
