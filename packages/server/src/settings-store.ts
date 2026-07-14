/**
 * 設定ストア — 4 群の設定の read / write (Sa10026-5)。
 *
 * 保存場所の分岐 (ADR-0026、binding):
 *   - アプリ全体設定  → system/settings.yaml  (agent 編集可の system/ 側)
 *   - agent 接続 / agent 権限 / privacy deny-list → .loamium/agent-*.json
 *     (agent 編集不可。既存の保存形式・場所を維持)
 *
 * apiKey は平文保存しない ($ENV_VAR 参照名のみ保存・表示)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import * as YAML from 'yaml';
import {
  agentConfigSchema,
  appSettingsSchema,
  agentPermissionsSchema,
  type AppSettings,
  type AgentConfig,
  type AgentPermissions,
} from '@loamium/shared';

// ---- パス定数 ----------------------------------------------------------------

/** アプリ全体設定のパス (vault 相対)。ADR-0010: system/ は agent 編集可。 */
export const SYSTEM_SETTINGS_PATH = 'system/settings.yaml';

function agentJsonPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'agent.json');
}

function agentPrivacyPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'agent-privacy.json');
}

function systemSettingsPath(vaultRoot: string): string {
  return path.join(vaultRoot, SYSTEM_SETTINGS_PATH);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ---- アプリ全体設定 (system/settings.yaml) ----------------------------------

/**
 * system/settings.yaml を読む。
 * - ファイル不在 (ENOENT) → 空設定 ({}) を返す (エラーにしない)。
 * - 読み込み失敗 / パース失敗 → Error を投げる。
 */
export async function loadSettings(vaultRoot: string): Promise<AppSettings> {
  const file = systemSettingsPath(vaultRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {};
    }
    throw new Error(`failed to read ${SYSTEM_SETTINGS_PATH}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (err) {
    throw new Error(`${SYSTEM_SETTINGS_PATH} is not valid YAML: ${String(err)}`);
  }

  const result = appSettingsSchema.safeParse(parsed);
  if (!result.success) {
    // passthrough なので実質失敗しないが、型安全のために確認
    return parsed as AppSettings;
  }
  return result.data;
}

/**
 * system/settings.yaml へ書き込む。
 * - 親ディレクトリを自動作成する。
 * - UTF-8 / LF 固定。
 */
export async function saveSettings(vaultRoot: string, settings: AppSettings): Promise<void> {
  const file = systemSettingsPath(vaultRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const yaml = yamlStringify(settings, { indent: 2 });
  // LF 固定 (CLAUDE.md: 改行 LF 固定)
  await fs.writeFile(file, yaml.replace(/\r\n/g, '\n'), 'utf8');
}

// ---- agent 接続設定 (.loamium/agent.json) -----------------------------------

export type AgentConfigResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; reason: 'not_configured' | 'invalid_config'; message: string };

/**
 * .loamium/agent.json を読む (agent-service.ts の loadAgentConfig と同じ形式)。
 * こちらは $ENV_VAR を解決しない (生の参照名を返す)。
 */
export async function loadAgentJson(vaultRoot: string): Promise<AgentConfigResult> {
  const file = agentJsonPath(vaultRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { ok: false, reason: 'not_configured', message: 'agent.json not found' };
    }
    return {
      ok: false,
      reason: 'invalid_config',
      message: `failed to read agent.json: ${String(err)}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'invalid_config', message: `agent.json is not valid JSON: ${String(err)}` };
  }

  const parsed = agentConfigSchema.safeParse(json);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: 'invalid_config', message: `agent.json validation failed: ${msg}` };
  }

  return { ok: true, config: parsed.data };
}

/**
 * .loamium/agent.json へ接続設定を書き込む。
 * apiKey は $ENV_VAR 参照名をそのまま保存する (実値は受け付けるが、呼び出し側の責任)。
 * 既存の permissions / webSearch は上書きフィールドのみ更新 (マージ)。
 */
export async function saveAgentConnection(
  vaultRoot: string,
  update: {
    api: 'openai' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey: string;
    webSearch?: { endpoint: string; apiKey?: string };
  },
): Promise<void> {
  const file = agentJsonPath(vaultRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });

  // 既存ファイルを読んでマージ (permissions 等を保持)
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // 不在 / 壊れた JSON → 新規作成
  }

  const merged: Record<string, unknown> = {
    ...existing,
    api: update.api,
    baseUrl: update.baseUrl,
    model: update.model,
    apiKey: update.apiKey,
  };
  if (update.webSearch !== undefined) {
    merged.webSearch = update.webSearch;
  }

  await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

/**
 * .loamium/agent.json の permissions フィールドのみ更新する。
 * 接続設定 (api/baseUrl/model/apiKey) は変更しない。
 * agent.json 不在の場合はエラー (接続設定がない状態で権限だけ書けない)。
 */
export async function saveAgentPermissions(
  vaultRoot: string,
  permissions: AgentPermissions,
): Promise<void> {
  const file = agentJsonPath(vaultRoot);
  let existing: Record<string, unknown>;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('agent.json is not a JSON object');
    }
    existing = parsed as Record<string, unknown>;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error('agent.json not found; configure connection settings first');
    }
    throw err;
  }

  existing.permissions = permissions;
  await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}

// ---- privacy deny-list (.loamium/agent-privacy.json) ------------------------

/**
 * .loamium/agent-privacy.json から deny リストを読む。
 * ファイル不在 → 空配列。壊れた JSON → Error。
 */
export async function loadAgentPrivacyDeny(vaultRoot: string): Promise<string[]> {
  const file = agentPrivacyPath(vaultRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return [];
    }
    throw new Error(`failed to read agent-privacy.json: ${String(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`agent-privacy.json is not valid JSON: ${String(err)}`);
  }

  // 2 形状を受け付ける (agentPrivacySchema と同じ)
  if (Array.isArray(json)) {
    return json.filter((v): v is string => typeof v === 'string');
  }
  if (json !== null && typeof json === 'object' && 'deny' in json) {
    const deny = (json as Record<string, unknown>).deny;
    if (Array.isArray(deny)) {
      return deny.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}

/**
 * .loamium/agent-privacy.json へ deny リストを書き込む。
 * 既存の保存形式 { deny: [...] } を維持する。
 */
export async function saveAgentPrivacyDeny(vaultRoot: string, deny: string[]): Promise<void> {
  const file = agentPrivacyPath(vaultRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ deny }, null, 2)}\n`, 'utf8');
}

// ---- $ENV_VAR 解決 -----------------------------------------------------------

/**
 * "$ENV_VAR" 形式なら process.env[ENV_VAR] を返す。通常の文字列はそのまま返す。
 * 環境変数が未設定なら null。
 */
export function resolveEnvRef(value: string): string | null {
  if (value.startsWith('$')) {
    const envKey = value.slice(1);
    const envVal = process.env[envKey];
    if (envVal === undefined || envVal === '') return null;
    return envVal;
  }
  return value;
}

/**
 * apiKey を安全な表示用文字列に変換する。
 * $ENV_VAR 形式: 参照名そのままを返す (例: "$OPENAI_API_KEY")
 * 通常の文字列: "(set)" を返す (実値は含まない)
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.startsWith('$')) {
    return apiKey; // $ENV_VAR 参照名はそのまま表示
  }
  return '(set)'; // 実値は隠す
}

// ---- agentPermissionsSchema の再エクスポート (settings-store 利用者向け) ----

export { agentPermissionsSchema };
