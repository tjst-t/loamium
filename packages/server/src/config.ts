import {
  permissionModeSchema,
  type PermissionMode,
  type TerminalDisabledReason,
} from '@loamium/shared';

/**
 * ターミナルブリッジ (WS /api/terminal — Sb7f458-1) の設定。
 * pty はブラウザから任意コマンド実行に等しいため、デフォルト無効。
 * LOAMIUM_TERMINAL=1 かつ LOAMIUM_MODE=full のときだけ有効 (SPEC §6 の明示オプトイン)。
 */
export interface TerminalConfig {
  enabled: boolean;
  /** 無効時の理由 (有効時は null) */
  reason: TerminalDisabledReason | null;
  /** pty で起動するコマンド (LOAMIUM_TERMINAL_CMD、既定 "claude")。シェル分解はしない */
  cmd: string;
}

export interface ServerConfig {
  /** vault ルートの絶対パス */
  vaultRoot: string;
  /** 権限モード (LOAMIUM_MODE) */
  mode: PermissionMode;
  /** アップロードのサイズ上限バイト数 (LOAMIUM_MAX_UPLOAD、既定 50MB) */
  maxUploadBytes: number;
  /** ターミナルブリッジ (Sb7f458) */
  terminal: TerminalConfig;
}

export const DEFAULT_TERMINAL_CMD = 'claude';

/**
 * 三重ガードのうち 2 枚 (env フラグ + full モード) を起動時に確定する。
 * (3 枚目はバインド先 — index.ts の LOAMIUM_HOST 既定 127.0.0.1)
 */
export function terminalConfigFromEnv(
  env: NodeJS.ProcessEnv,
  mode: PermissionMode,
): TerminalConfig {
  const cmd =
    env.LOAMIUM_TERMINAL_CMD !== undefined && env.LOAMIUM_TERMINAL_CMD !== ''
      ? env.LOAMIUM_TERMINAL_CMD
      : DEFAULT_TERMINAL_CMD;
  if (env.LOAMIUM_TERMINAL !== '1') {
    return { enabled: false, reason: 'terminal_env_not_set', cmd };
  }
  if (mode !== 'full') {
    return { enabled: false, reason: 'mode_not_full', cmd };
  }
  return { enabled: true, reason: null, cmd };
}

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * LOAMIUM_MAX_UPLOAD をバイト数にパースする。
 * 素の整数はバイト、"50mb" / "512kb" / "1gb" のような単位付きも受ける (大小不区別)。
 */
export function parseMaxUpload(raw: string): number {
  const m = /^(\d+)\s*(kb|mb|gb)?$/i.exec(raw.trim());
  if (m === null) {
    throw new Error(
      `invalid LOAMIUM_MAX_UPLOAD: "${raw}" (expected bytes or a value like "50mb")`,
    );
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const factor = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 * 1024 : unit === 'gb' ? 1024 ** 3 : 1;
  return n * factor;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const vaultRoot = env.LOAMIUM_VAULT;
  if (!vaultRoot) {
    throw new Error('LOAMIUM_VAULT environment variable is required (path to the vault root)');
  }
  const modeRaw = env.LOAMIUM_MODE ?? 'full';
  const parsed = permissionModeSchema.safeParse(modeRaw);
  if (!parsed.success) {
    throw new Error(
      `invalid LOAMIUM_MODE: "${modeRaw}" (expected full | read-only | append-only)`,
    );
  }
  const maxUploadBytes =
    env.LOAMIUM_MAX_UPLOAD !== undefined && env.LOAMIUM_MAX_UPLOAD !== ''
      ? parseMaxUpload(env.LOAMIUM_MAX_UPLOAD)
      : DEFAULT_MAX_UPLOAD_BYTES;
  return {
    vaultRoot,
    mode: parsed.data,
    maxUploadBytes,
    terminal: terminalConfigFromEnv(env, parsed.data),
  };
}
