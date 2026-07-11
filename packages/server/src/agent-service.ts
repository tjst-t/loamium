/**
 * エージェントサービス。
 *
 * - .loamium/agent.json を遅延読込し pi SDK のセッションを作成する。
 * - セッションは .loamium/agent-sessions/ 下の JSONL ファイルに永続化する。
 * - noTools:'all' — Story 3 でツールを追加するまでテキスト応答のみ。
 * - 監査ログへのエントリ書き込みは routes 側が行う。
 *
 * pi SDK 実 API (v0.80.x):
 *   - createAgentSession({ noTools:'all', sessionManager, authStorage, modelRegistry })
 *   - session.subscribe(listener: AgentSessionEventListener) → unsubscribe fn
 *   - session.prompt(text) → Promise<void>
 *   - session.abort() → Promise<void>
 *   - session.messages → AgentMessage[]   (最終確定メッセージ一覧)
 *   - session.sessionId → string
 *   - session.sessionName → string|undefined
 *   - AgentSessionEvent 種別:
 *       message_update { assistantMessageEvent: { type:'text_delta', delta } }
 *       tool_execution_start { toolCallId, toolName, args }
 *       tool_execution_end   { toolCallId, toolName }
 *       agent_end / agent_settled (turn complete)
 *   - SessionManager.create(cwd, sessionDir) — disk-backed JSONL
 *   - SessionManager.list(cwd, sessionDir) → Promise<SessionInfo[]>
 *   - ModelRegistry.inMemory(authStorage) — in-memory (models.json 不要)
 *   - AuthStorage.inMemory() — no file dependency
 *   - modelRegistry.registerProvider(name, { api, baseUrl, apiKey, models:[...] })
 *   - authStorage.setRuntimeApiKey(provider, key)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { agentConfigSchema, type AgentConfig } from '@loamium/shared';
import type { ServerConfig } from './config.js';

// ---- 設定読込 ---------------------------------------------------------------

export type AgentConfigResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; reason: 'not_configured' | 'invalid_config'; message: string };

/**
 * .loamium/agent.json を毎回読み直す (キャッシュしない — 再起動不要設定変更)。
 * $ENV_VAR 形式の値は process.env から解決する。
 */
export async function loadAgentConfig(vaultRoot: string): Promise<AgentConfigResult> {
  const configPath = path.join(vaultRoot, '.loamium', 'agent.json');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
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
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, reason: 'invalid_config', message: `agent.json validation failed: ${msg}` };
  }

  // $ENV_VAR 参照を解決する
  const config = parsed.data;
  const resolvedApiKey = resolveEnvRef(config.apiKey);
  if (resolvedApiKey === null) {
    return {
      ok: false,
      reason: 'invalid_config',
      message: `apiKey references an environment variable that is not set: ${config.apiKey}`,
    };
  }

  return { ok: true, config: { ...config, apiKey: resolvedApiKey } };
}

/** "$ENV_VAR" → process.env[ENV_VAR] or null 。通常の文字列はそのまま。 */
function resolveEnvRef(value: string): string | null {
  if (value.startsWith('$')) {
    const envKey = value.slice(1);
    const envVal = process.env[envKey];
    if (envVal === undefined || envVal === '') return null;
    return envVal;
  }
  return value;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ---- セッション管理 ----------------------------------------------------------

/**
 * セッションディレクトリ (vault-local)
 * .loamium/agent-sessions/ 以下に JSONL を保存する。
 */
function sessionDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'agent-sessions');
}

/**
 * in-flight セッションのキャッシュ (sessionId → AgentSession)。
 * セッション作成後もオブジェクトを保持し prompt/abort の呼び出しに使う。
 */
const activeSessionsById = new Map<string, AgentSession>();

/**
 * セッションを新規作成する (disk-backed JSONL)。
 * config は遅延読込済みを渡す。
 */
export async function createPiSession(
  vaultRoot: string,
  config: AgentConfig,
): Promise<AgentSession> {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  // プロバイダ登録 (baseUrl + api adapter + model)
  const providerName = `loamium-${config.api}-${Date.now()}`;
  const apiAdapter = config.api === 'openai' ? 'openai-completions' : 'anthropic-messages';
  modelRegistry.registerProvider(providerName, {
    api: apiAdapter,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });

  // API キーを runtime override でセットする (auth.json 不要)
  authStorage.setRuntimeApiKey(providerName, config.apiKey);

  const model = modelRegistry.find(providerName, config.model);
  if (!model) {
    throw new Error(`model not found after registration: ${config.model}`);
  }

  const dir = sessionDir(vaultRoot);
  await fs.mkdir(dir, { recursive: true });

  const sm = SessionManager.create(vaultRoot, dir);

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: sm,
    noTools: 'all',
  });

  activeSessionsById.set(session.sessionId, session);
  return session;
}

/**
 * 既存セッションを開く (disk-backed。AgentSession はファイルから復元)。
 * config は遅延読込済みを渡す。
 */
export async function openPiSession(
  sessionFile: string,
  vaultRoot: string,
  config: AgentConfig,
): Promise<AgentSession> {
  // 既に active なら再利用
  const existingSessionId = getSessionIdFromFile(sessionFile);
  if (existingSessionId) {
    const existing = activeSessionsById.get(existingSessionId);
    if (existing) return existing;
  }

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  const providerName2 = `loamium-${config.api}-${Date.now()}`;
  const apiAdapter2 = config.api === 'openai' ? 'openai-completions' : 'anthropic-messages';
  modelRegistry.registerProvider(providerName2, {
    api: apiAdapter2,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });
  authStorage.setRuntimeApiKey(providerName2, config.apiKey);

  const model = modelRegistry.find(providerName2, config.model);
  if (!model) throw new Error(`model not found: ${config.model}`);

  const dir = sessionDir(vaultRoot);
  const sm = SessionManager.open(sessionFile, dir);

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: sm,
    noTools: 'all',
  });

  activeSessionsById.set(session.sessionId, session);
  return session;
}

/** sessionFile パスからセッション ID を推定する (ファイル名 = <id>.jsonl)。 */
function getSessionIdFromFile(sessionFile: string): string | null {
  const base = path.basename(sessionFile, '.jsonl');
  return base || null;
}

/** active キャッシュからセッションを取得する。 */
export function getActiveSession(sessionId: string): AgentSession | undefined {
  return activeSessionsById.get(sessionId);
}

/**
 * sessionId を指定してディスクから JSONL を開き AgentSession を返す。
 * アクティブキャッシュがあれば再利用する (disk fast-path)。
 * サーバー再起動後のセッション復元に使用する。
 */
export async function getSessionFromDisk(
  sessionId: string,
  vaultRoot: string,
  config: AgentConfig,
): Promise<AgentSession> {
  // キャッシュ優先
  const cached = activeSessionsById.get(sessionId);
  if (cached) return cached;

  const dir = sessionDir(vaultRoot);
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);
  return openPiSession(sessionFile, vaultRoot, config);
}

/** セッションディレクトリ下のすべてのセッション一覧を返す。 */
export async function listSessions(config: ServerConfig): Promise<{
  id: string;
  title: string | null;
  updatedAt: number;
}[]> {
  const dir = sessionDir(config.vaultRoot);
  try {
    const infos = await SessionManager.list(config.vaultRoot, dir);
    // 新しい順
    return infos
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .map((info) => ({
        id: info.id,
        title: info.name ?? null,
        updatedAt: info.modified.getTime(),
      }));
  } catch {
    return [];
  }
}

/**
 * セッション JSONL を読み、UI 表示用のメッセージ列を再構築する。
 * pi の SessionManager.getEntries() を使い、user/assistant を抽出する。
 */
export function extractSessionMessages(session: AgentSession): {
  role: 'user' | 'assistant';
  content: string;
  tools: { name: string; argsSummary: string; status: 'running' | 'done' }[];
}[] {
  const msgs: ReturnType<typeof extractSessionMessages> = [];
  const piMessages = session.messages;

  for (const msg of piMessages) {
    if (msg.role === 'user') {
      const textContent = extractText(msg.content);
      if (textContent) {
        msgs.push({ role: 'user', content: textContent, tools: [] });
      }
    } else if (msg.role === 'assistant') {
      const textContent = extractText(msg.content);
      const toolUses = extractToolUses(msg.content);
      if (textContent || toolUses.length > 0) {
        msgs.push({
          role: 'assistant',
          content: textContent,
          tools: toolUses.map((t) => ({
            name: t.name,
            argsSummary: t.argsSummary,
            status: 'done' as const,
          })),
        });
      }
    }
  }

  return msgs;
}

/** メッセージのコンテンツ配列/文字列からテキストを抽出する。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && (c as Record<string, unknown>)['type'] === 'text')
      .map((c) => c.text)
      .join('');
  }
  return '';
}

/** メッセージからツール呼び出しを抽出する。 */
function extractToolUses(content: unknown): { name: string; argsSummary: string }[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is { type: 'tool_use'; name: string; input: unknown } =>
      typeof c === 'object' && c !== null && (c as Record<string, unknown>)['type'] === 'tool_use',
    )
    .map((c) => ({
      name: c.name,
      argsSummary: JSON.stringify(c.input ?? {}).slice(0, 80),
    }));
}

/**
 * セッションの最初のユーザーメッセージからタイトルを派生させ、
 * pi SDK の setSessionName() で設定する (JSONL に永続化される)。
 * タイトルが既に設定済みの場合は何もしない。
 */
export function updateSessionTitle(session: AgentSession, _vaultRoot: string): void {
  if (session.sessionName) return; // 既に設定済み

  const messages = session.messages;
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractText(msg.content).trim();
      if (text) {
        const title = text.length > 50 ? text.slice(0, 50) + '…' : text;
        session.setSessionName(title);
        return;
      }
    }
  }
}
