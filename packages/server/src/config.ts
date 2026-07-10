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
  /**
   * CSWSH Origin 検査で追加許可するオリジン (LOAMIUM_TERMINAL_ALLOWED_ORIGINS、
   * カンマ区切り)。ループバック + same-origin に加えて、ここに列挙した Origin
   * (例: http://10.10.254.36:8203) からの WS 接続を許可する。既定は空 (従来どおり
   * ループバック運用のみ)。各要素は URL.origin へ正規化済み (scheme://host[:port])、
   * または `*.example.com` 形式のサブドメインワイルドカード。
   */
  allowedOrigins: string[];
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
 * サブドメインワイルドカード `*.example.com` / `https://*.example.com` を正規化する。
 * ワイルドカードでなければ null。base が単一ラベル (`*.net` 等の TLD 全体開放) や
 * 不正文字を含む危険な指定も null で弾く (壊れた/広すぎる設定でガードを緩めない)。
 */
function isWildcardShaped(entry: string): boolean {
  const sep = entry.indexOf('://');
  const hostPart = sep === -1 ? entry : entry.slice(sep + 3);
  return hostPart.startsWith('*.');
}

function normalizeWildcardOrigin(entry: string): string | null {
  const lower = entry.toLowerCase();
  const sep = lower.indexOf('://');
  const scheme = sep === -1 ? null : lower.slice(0, sep);
  const hostPart = sep === -1 ? lower : lower.slice(sep + 3);
  const base = hostPart.slice(2);
  // base は最低 2 ラベル (ドット必須) を要求し、*.net のような TLD 全体開放を防ぐ
  if (!base.includes('.') || base.startsWith('.') || base.endsWith('.')) return null;
  if (scheme !== null && scheme !== 'http' && scheme !== 'https') return null;
  if (/[^a-z0-9.-]/.test(base)) return null; // 不正文字
  return scheme === null ? `*.${base}` : `${scheme}://*.${base}`;
}

/**
 * LOAMIUM_TERMINAL_ALLOWED_ORIGINS (カンマ区切り) を許可エントリ配列へ正規化する。
 * 通常オリジンは URL.origin へ畳む。`*.example.com` 形式はサブドメインワイルドカード
 * として保持する (照合は isAllowedOrigin)。空要素・空白・パース不能な値は捨てる
 * (壊れた設定でガードを緩めない)。
 * 例: "http://10.10.254.36:8203, https://*.tjstkm.net"
 *     → ["http://10.10.254.36:8203", "https://*.tjstkm.net"]
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    if (isWildcardShaped(trimmed)) {
      // ワイルドカード指定は検証を通ったものだけ採用し、失敗しても URL parse に落とさない
      const wildcard = normalizeWildcardOrigin(trimmed);
      if (wildcard !== null) out.push(wildcard);
      continue;
    }
    try {
      out.push(new URL(trimmed).origin);
    } catch {
      // パース不能なオリジンは無視 (許可リストに載せない)
    }
  }
  return out;
}

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
  const allowedOrigins = parseAllowedOrigins(env.LOAMIUM_TERMINAL_ALLOWED_ORIGINS);
  if (env.LOAMIUM_TERMINAL !== '1') {
    return { enabled: false, reason: 'terminal_env_not_set', cmd, allowedOrigins };
  }
  if (mode !== 'full') {
    return { enabled: false, reason: 'mode_not_full', cmd, allowedOrigins };
  }
  return { enabled: true, reason: null, cmd, allowedOrigins };
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
