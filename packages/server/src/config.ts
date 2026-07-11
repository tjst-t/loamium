import {
  permissionModeSchema,
  type PermissionMode,
} from '@loamium/shared';

export interface ServerConfig {
  /** vault ルートの絶対パス */
  vaultRoot: string;
  /** 権限モード (LOAMIUM_MODE) */
  mode: PermissionMode;
  /** アップロードのサイズ上限バイト数 (LOAMIUM_MAX_UPLOAD、既定 50MB) */
  maxUploadBytes: number;
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
  };
}
