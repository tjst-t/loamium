/**
 * エージェントサービス。
 *
 * - .loamium/agent.json を遅延読込し pi SDK のセッションを作成する。
 * - セッションは .loamium/agent-sessions/ 下の JSONL ファイルに永続化する。
 * - tools: VAULT_READ_TOOL_NAMES — pi SDK の allowlist 機能を使い Loamium 独自 5 ツールのみ
 *   公開する (ADR-0008)。noTools:'all' は customTools も含め全ツールを抑制するため NG。
 *   pi SDK 内部: allowedToolNames = new Set(options.tools) でフィルタリングされ、
 *   カスタムツールも isAllowedTool(name) を通るため empty-set では全ブロックになる。
 *   allowlist に 5 ツール名を渡すことで built-in (bash/edit/write/find/grep/ls/read) を
 *   排除しつつカスタムツールのみ LLM に広告できる。(sdk.js:132, agent-session.js:1916)
 * - excludeTools: PI_BUILTIN_TOOL_NAMES — defense-in-depth。カスタムツール名 read_note が
 *   pi 組み込み read と衝突しなくなったため、allowlist と組み合わせて組み込みを二重に排除する。
 *   pi SDK: isAllowedTool = (!allowedNames || allowedNames.has(name)) && !excludedNames.has(name)
 *   (sdk.js:133-135, agent-session.js:1916)。excludeTools は CreateAgentSessionOptions の公開 API。
 * - 監査ログへのエントリ書き込みは routes 側が行う。
 *
 * pi SDK 実 API (v0.80.x):
 *   - createAgentSession({ tools:[...names], customTools:[...], sessionManager, authStorage, modelRegistry })
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
 *
 * セキュリティ:
 *   - セッション ID はアルファベット・数字・ハイフン・アンダースコアのみ許可する
 *     (/^[A-Za-z0-9_-]+$/)。それ以外は 400 を返す前にファイルシステムへ
 *     アクセスしてはならない (パストラバーサル防止)。
 *   - validateSessionId() を通さない sessionId はいかなる場合もパス結合しない。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { agentConfigSchema, type AgentConfig } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { createVaultReadTools, VAULT_READ_TOOL_NAMES } from './agent-tools.js';
import { loadAgentPrivacy } from './agent-privacy.js';
import { buildAgentSystemPrompt } from './agent-prompt.js';

/**
 * pi-coding-agent 組み込みツール名 (ToolName = "read"|"bash"|"edit"|"write"|"grep"|"find"|"ls")。
 * allToolNames は node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js で確認。
 * excludeTools に渡して defense-in-depth — allowlist と二重に組み込みを排除する (ADR-0008)。
 */
const PI_BUILTIN_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;
import type { VaultIndex } from './noteIndex.js';

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
 * セッション ID の許可リスト正規表現。
 * アルファベット・数字・ハイフン・アンダースコアのみ。
 * これ以外の文字列はファイルシステムに触れる前に拒否する。
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * sessionId をバリデートし、無効なら Error を投げる。
 * 呼び出し元は catch して 400/404 を返すこと。
 */
export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
}

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
 * プロバイダ登録済みの { authStorage, modelRegistry, model } を返す共通ヘルパー。
 * createPiSession / openPiSession の重複 ~25 行を統合する。
 */
function buildModelRegistry(config: AgentConfig): {
  authStorage: ReturnType<typeof AuthStorage.inMemory>;
  modelRegistry: ReturnType<typeof ModelRegistry.inMemory>;
  model: ReturnType<ReturnType<typeof ModelRegistry.inMemory>['find']>;
} {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);

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
  return { authStorage, modelRegistry, model };
}

/**
 * base システムプロンプトを注入する resourceLoader を生成する (S10a31c-1 / ADR-0010)。
 *
 * pi SDK は createAgentSession に resourceLoader が渡されないと DefaultResourceLoader を
 * 内部生成し、実効システムプロンプトは空になる (agent-session.js:708 の getSystemPrompt() が
 * undefined → buildSystemPrompt の default が使われる)。ここでは DefaultResourceLoader を
 * systemPrompt = base プロンプトで構築し、Loamium 固有の base プロンプトを注入する。
 *
 * cwd/agentDir 由来のプロジェクト常駐リソース (extensions/skills/prompts/themes/
 * context files) は Loamium では使わないため noExtensions 等ですべて抑制し、
 * reload() で確定させたものを返す。
 */
async function buildAgentResourceLoader(vaultRoot: string): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: vaultRoot,
    agentDir: sessionDir(vaultRoot),
    systemPrompt: buildAgentSystemPrompt(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

/**
 * セッションを新規作成する (disk-backed JSONL)。
 * config は遅延読込済みを渡す。
 * index は vault 読み取りツール (ADR-0008) のクロージャへ渡す。
 */
export async function createPiSession(
  vaultRoot: string,
  config: AgentConfig,
  index: VaultIndex,
): Promise<AgentSession> {
  const { authStorage, modelRegistry, model } = buildModelRegistry(config);
  if (!model) {
    throw new Error(`model not found after registration: ${config.model}`);
  }

  const dir = sessionDir(vaultRoot);
  await fs.mkdir(dir, { recursive: true });

  const sm = SessionManager.create(vaultRoot, dir);

  // ADR-0014: 機密領域 deny リストをセッション生成時にロードし共通フィルタへ配線する。
  const { isDenied } = await loadAgentPrivacy(vaultRoot);
  const customTools = createVaultReadTools(index, vaultRoot, isDenied);
  const resourceLoader = await buildAgentResourceLoader(vaultRoot);

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: sm,
    // ADR-0010: Loamium がコードで生成した base システムプロンプトを注入する。
    resourceLoader,
    // ADR-0008: Loamium 独自ツールのみを LLM に広告する。
    // noTools:'all' は customTools も含め全ツールを抑制するため使用しない。
    // tools に allowlist を渡すことで built-in を排除しカスタムツールのみ広告される。
    // excludeTools は defense-in-depth — allowlist 変更時でも組み込みが漏れない。
    // (pi-coding-agent/dist/core/sdk.js:132-135, agent-session.js:1916)
    tools: [...VAULT_READ_TOOL_NAMES],
    excludeTools: [...PI_BUILTIN_TOOL_NAMES],
    customTools: [...customTools],
  });

  activeSessionsById.set(session.sessionId, session);
  return session;
}

/**
 * 既存セッションを開く (disk-backed。AgentSession はファイルから復元)。
 * config は遅延読込済みを渡す。
 * index は vault 読み取りツール (ADR-0008) のクロージャへ渡す。
 */
export async function openPiSession(
  sessionFile: string,
  vaultRoot: string,
  config: AgentConfig,
  index: VaultIndex,
): Promise<AgentSession> {
  // 既に active なら再利用
  const existingSessionId = getSessionIdFromFile(sessionFile);
  if (existingSessionId) {
    const existing = activeSessionsById.get(existingSessionId);
    if (existing) return existing;
  }

  const { authStorage, modelRegistry, model } = buildModelRegistry(config);
  if (!model) throw new Error(`model not found: ${config.model}`);

  const dir = sessionDir(vaultRoot);
  const sm = SessionManager.open(sessionFile, dir);

  // ADR-0014: 同上 — 既存セッションを開くたびに最新の deny リストを反映する。
  const { isDenied } = await loadAgentPrivacy(vaultRoot);
  const customTools = createVaultReadTools(index, vaultRoot, isDenied);
  const resourceLoader = await buildAgentResourceLoader(vaultRoot);

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: sm,
    // ADR-0010: 同上 — base システムプロンプトを注入する。
    resourceLoader,
    // ADR-0008: 同上 — built-in を排除しカスタムツールのみ広告する allowlist + excludeTools。
    tools: [...VAULT_READ_TOOL_NAMES],
    excludeTools: [...PI_BUILTIN_TOOL_NAMES],
    customTools: [...customTools],
  });

  activeSessionsById.set(session.sessionId, session);
  return session;
}

/** sessionFile パスからセッション ID を推定する (ファイル名 = <id>.jsonl)。
 * basename が validateSessionId を通らない場合は null を返す (Map キーとして使用しない)。
 */
function getSessionIdFromFile(sessionFile: string): string | null {
  const base = path.basename(sessionFile, '.jsonl');
  if (!base) return null;
  try {
    validateSessionId(base);
    return base;
  } catch {
    return null;
  }
}

/** active キャッシュからセッションを取得する。 */
export function getActiveSession(sessionId: string): AgentSession | undefined {
  return activeSessionsById.get(sessionId);
}

/**
 * sessionId を指定してディスクから JSONL を開き AgentSession を返す。
 * アクティブキャッシュがあれば再利用する (disk fast-path)。
 * サーバー再起動後のセッション復元に使用する。
 *
 * セキュリティ: 呼び出し元で validateSessionId() を通した sessionId のみ渡すこと。
 * 本関数でも defense-in-depth として生成パスがセッションディレクトリ内に
 * 収まることを確認する。
 */
export async function getSessionFromDisk(
  sessionId: string,
  vaultRoot: string,
  config: AgentConfig,
  index: VaultIndex,
): Promise<AgentSession> {
  // キャッシュ優先
  const cached = activeSessionsById.get(sessionId);
  if (cached) return cached;

  const dir = sessionDir(vaultRoot);

  // pi の JSONL ファイル名は `<timestamp>_<id>.jsonl` であり `<id>.jsonl` ではない。
  // よって id からパスを組み立てず、SessionManager.list() が返す SessionInfo.path で
  // 実ファイルを解決する。id 一致が無ければ「実在しないセッション」= 呼び出し元で 404。
  // (これを怠ると存在しないパスに対し SessionManager.open が空セッションを新規作成し、
  //  復元のつもりが履歴を失って空セッションを作る — 未知 ID も 200 になる。)
  const infos = await SessionManager.list(vaultRoot, dir);
  const info = infos.find((i) => i.id === sessionId);
  if (!info) {
    throw new Error(`session not found on disk: ${sessionId}`);
  }

  // Defense-in-depth: 解決したパスが sessionsDir 内に収まることを検証する
  const resolvedFile = path.resolve(info.path);
  const resolvedDir = path.resolve(dir);
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
    throw new Error(`session file path escapes sessions directory: ${sessionId}`);
  }

  return openPiSession(info.path, vaultRoot, config, index);
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
 * セッション JSONL ファイルをディスクから削除し、アクティブキャッシュからも退避する。
 * - SessionManager.list() で実ファイルパスを解決する (<timestamp>_<id>.jsonl 形式)。
 * - 実在しないセッションは Error を投げる (呼び出し元が 404 を返す)。
 * - 呼び出し元で validateSessionId() を通した sessionId のみ渡すこと。
 */
export async function deleteSession(
  sessionId: string,
  vaultRoot: string,
): Promise<void> {
  const dir = sessionDir(vaultRoot);
  const infos = await SessionManager.list(vaultRoot, dir);
  const info = infos.find((i) => i.id === sessionId);
  if (!info) {
    throw new Error(`session not found on disk: ${sessionId}`);
  }

  // Defense-in-depth: 解決したパスがセッションディレクトリ内に収まることを確認する
  const resolvedFile = path.resolve(info.path);
  const resolvedDir = path.resolve(dir);
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
    throw new Error(`session file path escapes sessions directory: ${sessionId}`);
  }

  // ディスクから削除
  await fs.unlink(resolvedFile);

  // アクティブキャッシュから退避 (SessionManager には public な delete API が無いため直接 Map から削除)
  activeSessionsById.delete(sessionId);
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
