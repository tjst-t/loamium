/**
 * 同期設定ストア (ADR-0032 / Se29635-2)。
 *
 * 設定は `.loamium/sync.json` (vault 外・gitignore 済み) に保存する。
 * PAT フォールバック認証は `.loamium/sync-credentials.json` に **0600** で保存する。
 *
 * ## セキュリティ原則
 * - トークンは vault (git 管理下) / `.git/config` には絶対書かない。
 * - env `LOAMIUM_SYNC_TOKEN` は credentials.json より優先される (読み取り専用)。
 * - `load()` はパースエラーでも throw しない (priority 6: アプリを止めない)。
 */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDir } from '../fs-utils.js';

// ──────────────────────────────────────────────
// 設定型
// ──────────────────────────────────────────────

/**
 * `.loamium/sync.json` に永続化される同期設定のスキーマ。
 * token フィールドは含まない — 別ファイル (sync-credentials.json) に隔離する。
 */
export interface SyncConfig {
  /** 同期機能の有効/無効フラグ。 */
  enabled: boolean;
  /** リモート URL。null なら未設定 (同期を試みない)。 */
  remoteUrl: string | null;
  /** 同期対象ブランチ名。 */
  branch: string;
  /** git リモート名 (git remote に対応)。 */
  remoteName: string;
  /** 変更確定後に自動で commit→push する自動同期モード (Story 3)。 */
  autoSync: boolean;
  /** 自動同期の debounce ミリ秒 (Story 3)。 */
  debounceMs: number;
  /** 定期 pull インターバル ミリ秒 (Story 3)。 */
  pullIntervalMs: number;
  /** commit メッセージに付与する端末識別名。 */
  deviceName: string;
}

/** `.loamium/sync-credentials.json` に保存される認証情報の最小型。 */
interface SyncCredentials {
  token: string;
}

// ──────────────────────────────────────────────
// デフォルト値
// ──────────────────────────────────────────────

const DEFAULTS: SyncConfig = {
  enabled: false,
  remoteUrl: null,
  branch: 'main',
  remoteName: 'origin',
  autoSync: false,
  debounceMs: 30_000,
  pullIntervalMs: 900_000,
  deviceName: os.hostname(),
};

// ──────────────────────────────────────────────
// パスヘルパー
// ──────────────────────────────────────────────

function loamiumDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium');
}

function syncConfigPath(vaultRoot: string): string {
  return path.join(loamiumDir(vaultRoot), 'sync.json');
}

function syncCredentialsPath(vaultRoot: string): string {
  return path.join(loamiumDir(vaultRoot), 'sync-credentials.json');
}

// ──────────────────────────────────────────────
// SyncConfigStore
// ──────────────────────────────────────────────

/**
 * `.loamium/sync.json` および `.loamium/sync-credentials.json` を管理する軽量ストア。
 *
 * - `load()` はパースエラー・ENOENT 時もデフォルト値を返し、**throw しない**。
 * - `save(partial)` は merge → 永続化 し、ディレクトリを自動作成する。
 * - トークン: `getToken()` → `LOAMIUM_SYNC_TOKEN` env (優先) → credentials ファイル。
 * - トークン: `setToken(token)` → credentials ファイルを **0600** で書く。
 */
export class SyncConfigStore {
  readonly #vaultRoot: string;

  constructor(vaultRoot: string) {
    this.#vaultRoot = vaultRoot;
  }

  /**
   * 設定を読み込む。ファイル不在・パースエラーはデフォルト値で吸収する (throw しない)。
   */
  load(): SyncConfig {
    // 同期 readFile が必要なため fs.readFileSync を使う
    // (このメソッドは SyncEngine のゲッタ `getConfig` から呼ばれるため同期が自然)
    try {
      const raw = readFileSync(syncConfigPath(this.#vaultRoot), 'utf8');
      const parsed = JSON.parse(raw) as Partial<SyncConfig>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * 部分的な設定をマージして永続化する。
   * `.loamium/` ディレクトリが存在しない場合は作成する。
   *
   * `exactOptionalPropertyTypes` のため、呼び出し元は `Partial<SyncConfig>` を渡すが、
   * undefined フィールドは spread でスキップされるため現在値が保持される。
   */
  async save(partial: Record<string, unknown>): Promise<SyncConfig> {
    await ensureDir(loamiumDir(this.#vaultRoot));
    const current = this.load();
    // undefined を明示的に除去してから merge する (exactOptionalPropertyTypes 対応)
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) cleaned[k] = v;
    }
    const merged: SyncConfig = { ...current, ...(cleaned as Partial<SyncConfig>) };
    await fs.writeFile(
      syncConfigPath(this.#vaultRoot),
      JSON.stringify(merged, null, 2) + '\n',
      { encoding: 'utf8' },
    );
    return merged;
  }

  /**
   * PAT トークンを返す。
   * 優先順位: env `LOAMIUM_SYNC_TOKEN` > `.loamium/sync-credentials.json`。
   * 未設定なら null を返す。
   */
  getToken(): string | null {
    // env が設定されている場合は常に優先 (読み取り専用・ファイルへの書き込みは行わない)
    const envToken = process.env.LOAMIUM_SYNC_TOKEN;
    if (envToken && envToken.length > 0) {
      return envToken;
    }

    // credentials ファイルから同期読み込み
    try {
      const raw = readFileSync(syncCredentialsPath(this.#vaultRoot), 'utf8');
      const creds = JSON.parse(raw) as SyncCredentials;
      return creds.token && creds.token.length > 0 ? creds.token : null;
    } catch {
      return null;
    }
  }

  /**
   * PAT トークンを `.loamium/sync-credentials.json` に **mode 0600** で保存する。
   *
   * セキュリティ:
   * - vault (git 管理下) には書かない。`.loamium/` は gitignore 済み。
   * - `.git/config` には書かない。per-command extraheader で渡す。
   */
  async setToken(token: string): Promise<void> {
    await ensureDir(loamiumDir(this.#vaultRoot));
    const credPath = syncCredentialsPath(this.#vaultRoot);
    const content = JSON.stringify({ token } satisfies SyncCredentials, null, 2) + '\n';
    // まず 0600 で書き、chmod で二重に確認する
    await fs.writeFile(credPath, content, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(credPath, 0o600);
  }

  /**
   * 設定を返すが、token フィールドを除外した安全なオブジェクトを返す。
   * GET /api/sync/config のレスポンスに使う。
   */
  redactedConfig(): SyncConfig & { tokenConfigured: boolean } {
    const cfg = this.load();
    const token = this.getToken();
    return {
      ...cfg,
      tokenConfigured: token !== null,
    };
  }
}
