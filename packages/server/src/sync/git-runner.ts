/**
 * Git シェルアウト抽象層 (ADR-0032 / Se29635-1)。
 *
 * システム git へシェルアウトする最薄の抽象レイヤ。
 * - `GitRunner` インタフェースで差し替え可能にし、テストはスタブを注入する。
 * - git バイナリ不在 (spawn ENOENT / `git --version` 失敗) と
 *   git コマンドの非ゼロ終了 (非 ff マージ失敗・conflict 等) を明確に区別する。
 * - 秘密情報 (http.extraheader の Authorization 等) を throw メッセージやログに
 *   そのまま出すことを禁止する。
 */
import { spawn } from 'node:child_process';

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/** git コマンド 1 回の実行結果。非ゼロ終了は throw せずここに詰める。 */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `GitRunner.run` に渡せる任意オプション。 */
export interface GitRunOpts {
  /** 作業ディレクトリ (省略時は node プロセスの cwd)。 */
  cwd?: string;
  /** ミリ秒単位のタイムアウト。超過時は子プロセスを kill する。 */
  timeoutMs?: number;
  /** 追加の環境変数。プロセス env をベースにマージする。 */
  env?: Record<string, string>;
}

/** git 実行の抽象インタフェース。テストはこれをスタブ化して注入する。 */
export interface GitRunner {
  /**
   * git コマンドを実行する。
   * - git バイナリが存在しない (spawn ENOENT) → `GitUnavailableError` を throw。
   * - git コマンドが非ゼロで終了 → throw せず `GitResult.code` に載せて返す。
   */
  run(args: string[], opts?: GitRunOpts): Promise<GitResult>;

  /**
   * `git --version` が通るか確認する。
   * - 結果はキャッシュしてよい。
   * - git 不在でも throw せず `false` を返す。
   */
  isAvailable(): Promise<boolean>;
}

// ──────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────

/**
 * git バイナリが利用不可であることを示す明示エラー。
 * ADR-0025 の LocalLlmUnavailableError と同じパターン: 握りつぶしではなく
 * 「同期機能のみ無効化」を呼び出し側へ明示するための正当な利用不可通知。
 */
export class GitUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitUnavailableError';
  }
}

/**
 * git の stderr / 出力に紛れ込みうる認証情報を伏字化する。
 * ADR-0032: 秘密情報 (URL 内 userinfo・Authorization ヘッダ値) を throw メッセージ・
 * `SyncResult.error`・監査ログにそのまま出さない。token-in-URL 構成は ADR-0032 上
 * サポート外だが、誤設定時の漏洩を最小化する。網羅的である必要はない。
 */
export function redactGitSecrets(s: string): string {
  return s
    // https://user:token@host → https://<redacted>@host
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
    // Authorization: Basic xxxx / Authorization: Bearer xxxx
    .replace(/(authorization:\s*\S+\s+)\S+/gi, '$1<redacted>');
}

// ──────────────────────────────────────────────
// SystemGitRunner
// ──────────────────────────────────────────────

/** デフォルトタイムアウト: 30 秒。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * システムにインストールされた git へシェルアウトする `GitRunner` 実装。
 *
 * git は同梱しない — PATH 上の `git` バイナリを使用する。
 * これにより:
 * 1. バンドルサイズを増やさない (ADR-0032)。
 * 2. OS / CI の git バージョン管理をユーザーに委ねる。
 */
export class SystemGitRunner implements GitRunner {
  /** `isAvailable()` の結果をキャッシュする。`null` は未確認。 */
  #availableCache: boolean | null = null;

  async run(args: string[], opts: GitRunOpts = {}): Promise<GitResult> {
    const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env } = opts;
    const mergedEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : process.env;

    return new Promise<GitResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', args, {
          cwd,
          env: mergedEnv,
          // stdio: pipe にしてバッファする
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (spawnErr) {
        // 同期 throw (稀なケース — 非同期 ENOENT は error イベントで来る)
        reject(new GitUnavailableError('git binary not found', { cause: spawnErr }));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      let timedOut = false;
      let closed = false;
      // タイムアウト時は SIGTERM → 1 秒後も生きていれば SIGKILL でエスカレーションし、
      // credential プロンプトや遅い network stack で 'close' が来ずハングするのを防ぐ。
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 1_000);
      }, timeoutMs);

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (err.code === 'ENOENT') {
          // git バイナリが見つからない → GitUnavailableError
          reject(new GitUnavailableError('git binary not found (ENOENT)', { cause: err }));
        } else {
          reject(err);
        }
      });

      child.on('close', (code: number | null) => {
        closed = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (timedOut) {
          reject(new Error(`git command timed out after ${timeoutMs}ms`));
          return;
        }

        // 非ゼロ終了は throw しない — GitResult.code に載せる
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    // キャッシュ済みなら再確認しない
    if (this.#availableCache !== null) return this.#availableCache;

    try {
      const result = await this.run(['--version'], { timeoutMs: 5_000 });
      this.#availableCache = result.code === 0;
    } catch {
      // GitUnavailableError や spawn エラーを捕捉 — 不在として false を返す
      this.#availableCache = false;
    }
    return this.#availableCache;
  }
}
