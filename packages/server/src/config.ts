import { permissionModeSchema, type PermissionMode } from '@loamium/shared';

export interface ServerConfig {
  /** vault ルートの絶対パス */
  vaultRoot: string;
  /** 権限モード (LOAMIUM_MODE) */
  mode: PermissionMode;
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
  return { vaultRoot, mode: parsed.data };
}
