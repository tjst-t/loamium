/**
 * Vault 自動同期スケジューラ (ADR-0032 / Se29635-3)。
 *
 * - vault の変更を検知し、debounce 後に auto-commit → push する (AC-3-1)。
 * - 定期 pull インターバル + オフラインキューのリトライを管理する (AC-3-2 / AC-3-3)。
 * - アプリ終了 / ウィンドウブラー時は `flush()` で pending debounce を即時実行する (AC-3-1)。
 *
 * ## 無限ループ防止
 * pull が引き起こす vault 変更 (watcher 経由) が再度 auto-commit を呼ばないよう、
 * pull 実行中は `#pulling` フラグで debounce 発火を抑止する。
 * pull 後のツリーがクリーンな場合は commit() が false を返すため、
 * フラグが機能しなくても空 commit は作られない (二重保護)。
 */
import { SyncEngine } from './sync-engine.js';
import type { SyncConfigStore } from './sync-config.js';

// ──────────────────────────────────────────────
// 型
// ──────────────────────────────────────────────

export interface SyncSchedulerOpts {
  engine: SyncEngine;
  store: SyncConfigStore;
}

// ──────────────────────────────────────────────
// SyncScheduler
// ──────────────────────────────────────────────

export class SyncScheduler {
  readonly #engine: SyncEngine;
  readonly #store: SyncConfigStore;

  /** 定期 pull インターバルタイマー。 */
  #pullInterval: ReturnType<typeof setInterval> | null = null;
  /** debounce タイマー。 */
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** pull 実行中フラグ (pull による vault 変更で auto-commit が無駄に走るのを防ぐ)。 */
  #pulling = false;
  /** 同期処理 (autoSync / periodic pull) の同時実行を防ぐ in-flight ロック。 */
  #inFlight = false;
  /** in-flight 中に来た auto-sync 要求を保留し、完了後に一度だけ再実行するフラグ。 */
  #pendingAutoSync = false;

  constructor(opts: SyncSchedulerOpts) {
    this.#engine = opts.engine;
    this.#store = opts.store;
  }

  // ──────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────

  /**
   * スケジューラを起動する。
   *
   * `config.pullIntervalMs` ごとに pull + オフラインリトライを実行する。
   * autoSync が無効・リモート未設定・git 不在の場合は各ティックで no-op にする。
   */
  start(): void {
    // 既に起動中なら再起動しない
    if (this.#pullInterval !== null) return;

    this.#pullInterval = setInterval(
      () => void this.#runPeriodicPull().catch((err: unknown) => {
        console.error('[sync-scheduler] 定期 pull エラー:', err);
      }),
      this.#store.load().pullIntervalMs,
    );
    // サーバー終了を妨げないよう unref する
    this.#pullInterval.unref();
  }

  /**
   * vault 変更コールバック。`index.setOnChange` から呼び出す。
   *
   * `.loamium/` 配下の変更 (audit.log 等) は無視する。
   * pull 中 (`#pulling`) は debounce を新たにスケジュールしない。
   * debounceMs は毎回 store から動的に読む (設定変更を即反映)。
   */
  onVaultChange(path: string, _op: string): void {
    // .loamium/ 配下の変更は自己起因のため無視する
    if (path.startsWith('.loamium/') || path === '.loamium') return;

    // pull 中は auto-commit をトリガーしない (無限ループ防止)
    if (this.#pulling) return;

    const cfg = this.#store.load();
    // autoSync が無効・リモート未設定の場合は debounce しない
    if (!cfg.enabled || !cfg.autoSync || !cfg.remoteUrl) return;

    // 既存 debounce タイマーをリセットする
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
    }

    this.#debounceTimer = setTimeout(
      () => void this.#runAutoSync().catch((err: unknown) => {
        console.error('[sync-scheduler] auto-sync エラー:', err);
      }),
      cfg.debounceMs,
    );
    // サーバー終了を妨げないよう unref する
    this.#debounceTimer.unref();
  }

  /**
   * pending な debounce があれば即時実行する (アプリ終了 / ウィンドウブラー時)。
   *
   * non-throwing: エラーはログのみ。
   */
  async flush(): Promise<void> {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
      // pending debounce があったので即時実行する
      await this.#runAutoSync().catch((err: unknown) => {
        console.error('[sync-scheduler] flush auto-sync エラー:', err);
      });
    }
  }

  /**
   * スケジューラを停止する。
   *
   * インターバルと pending debounce をクリアし、最後に `flush()` を実行する (非致命的)。
   */
  async stop(): Promise<void> {
    if (this.#pullInterval !== null) {
      clearInterval(this.#pullInterval);
      this.#pullInterval = null;
    }
    // pending debounce を flush して終了時の auto-commit を担保する (AC-3-1)
    await this.flush().catch((err: unknown) => {
      console.error('[sync-scheduler] stop 時の flush エラー:', err);
    });
  }

  // ──────────────────────────────────────────
  // プライベートヘルパー
  // ──────────────────────────────────────────

  /**
   * 定期 pull ティック処理。
   * autoSync が無効・リモート未設定・git 不在なら no-op。
   */
  async #runPeriodicPull(): Promise<void> {
    const cfg = this.#store.load();
    if (!cfg.enabled || !cfg.remoteUrl) return;

    // git 利用可否を確認 (不在なら no-op)
    const status = await this.#engine.status();
    if (!status.available) return;

    // 別の同期処理が実行中なら次ティックに委ねる (git 状態の競合防止, Finding 2)
    if (this.#inFlight) return;
    this.#inFlight = true;
    this.#pulling = true;
    // pull 開始時に pending debounce をキャンセルし、pull の途中で auto-commit が
    // 走らないようにする (Finding 3)。降ったファイルは次の編集で拾われる。
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    try {
      await this.#engine.pull('periodic');
      // オフラインキューがあればリトライする (AC-3-3)
      await this.#engine.retryIfPending();
    } finally {
      this.#pulling = false;
      this.#inFlight = false;
      this.#drainPendingAutoSync();
    }
  }

  /**
   * auto-commit → push を実行する。
   * autoSync が無効・リモート未設定・git 不在なら no-op。
   * 別の同期処理が実行中の場合は保留し、完了後に一度だけ再実行する (Finding 2)。
   */
  async #runAutoSync(): Promise<void> {
    this.#debounceTimer = null;

    const cfg = this.#store.load();
    if (!cfg.enabled || !cfg.autoSync || !cfg.remoteUrl) return;

    // git 利用可否を確認 (不在なら no-op)
    const status = await this.#engine.status();
    if (!status.available) return;

    // 同時実行中なら保留 (完了後に drain される)
    if (this.#inFlight) {
      this.#pendingAutoSync = true;
      return;
    }
    this.#inFlight = true;
    try {
      await this.#engine.autoSyncOnce();
    } finally {
      this.#inFlight = false;
      this.#drainPendingAutoSync();
    }
  }

  /** in-flight 中に保留された auto-sync 要求があれば一度だけ実行する。 */
  #drainPendingAutoSync(): void {
    if (!this.#pendingAutoSync) return;
    this.#pendingAutoSync = false;
    void this.#runAutoSync().catch((err: unknown) => {
      console.error('[sync-scheduler] 保留 auto-sync エラー:', err);
    });
  }
}
