/**
 * エージェントサービス。
 *
 * - .loamium/agent.json を遅延読込し pi SDK のセッションを作成する。
 * - セッションは .loamium/agent-sessions/ 下の JSONL ファイルに永続化する。
 * - tools: VAULT_READ_TOOL_NAMES — pi SDK の allowlist 機能を使い Loamium 独自 5 ツールのみ
 *   公開する (ADR-0012)。noTools:'all' は customTools も含め全ツールを抑制するため NG。
 *   pi SDK 内部: allowedToolNames = new Set(options.tools) でフィルタリングされ、
 *   カスタムツールも isAllowedTool(name) を通るため empty-set では全ブロックになる。
 *   allowlist に 5 ツール名を渡すことで built-in (bash/edit/write/find/grep/ls/read) を
 *   排除しつつカスタムツールのみ LLM に広告できる。(sdk.js:132, agent-session.js:1916)
 * - excludeTools: PI_BUILTIN_TOOL_NAMES — defense-in-depth。カスタムツール名 read_note が
 *   pi 組み込み read と衝突しなくなったため、allowlist と組み合わせて組み込みを二重に排除する。
 *   pi SDK: isAllowedTool = (!allowedNames || allowedNames.has(name)) && !excludedNames.has(name)
 *   (sdk.js:133-135, agent-session.js:1916)。excludeTools は CreateAgentSessionOptions の公開 API。
 * - REST の監査ログエントリは routes 側 (auditMiddleware) が行う。エージェント書き込み
 *   ツールは HTTP を通らないため、各ツールが note-service 経由の成功時に writeAuditEntry を
 *   直接呼ぶ (ADR-0016 / agent-write-tools.ts)。
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
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import {
  agentConfigSchema,
  clampByMode,
  deriveToolNames,
  resolvePermissions,
  type AgentConfig,
  type Capability,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { PermissionMode } from '@loamium/shared';
import { createVaultReadTools } from './agent-tools.js';
import { createVaultWriteTools } from './agent-write-tools.js';
import { createFileTools } from './agent-file-tools.js';
import { createVaultWebTools } from './agent-web-tools.js';
import { createSmartFolderTools } from './agent-smartfolder-tools.js';
import { createCommandTools } from './agent-command-tools.js';
import { createTemplateTools } from './agent-template-tools.js';
import { createVaultSeedTool } from './agent-vault-seed-tools.js';
import { loadAgentPrivacy } from './agent-privacy.js';
import { loadSessionPerms, saveSessionPerms } from './agent-session-perms.js';
import { buildAgentSystemPrompt } from './agent-prompt.js';
import { existsSync } from 'node:fs';
import { resolveModelFilePath, InvalidModelFilenameError } from './model-paths.js';
import { localLlmBaseUrl } from './routes/llm.js';

/**
 * pi-coding-agent 組み込みツール名 (ToolName = "read"|"bash"|"edit"|"write"|"grep"|"find"|"ls")。
 * allToolNames は node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js で確認。
 * excludeTools に渡して defense-in-depth — allowlist と二重に組み込みを排除する (ADR-0012)。
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

// ---- ケーパビリティ権限 (ADR-0015) ------------------------------------------

/**
 * 実効ケーパビリティを決定する (ADR-0015)。
 *
 *   実効権限 = clampByMode( sessionPerms ?? resolvePermissions(config.permissions), LOAMIUM_MODE )
 *
 * - sessionPerms: セッション権限ストア (agent-session-perms.json) から読んだ集合。
 *   無ければ (null) agent.json の permissions を resolvePermissions で解決 (未指定は read-only)。
 * - mode: サーバー LOAMIUM_MODE。クランプ表に従い許可外のケーパビリティを取り除く。
 *
 * routes と agent-service で共有する (GET 詳細の effectivePermissions とツール allowlist を
 * 同じ導出で一致させるため)。
 */
export function getEffectiveCapabilities(
  config: AgentConfig,
  sessionPerms: Capability[] | null,
  mode: PermissionMode,
): Capability[] {
  const base = sessionPerms ?? resolvePermissions(config.permissions);
  return clampByMode(base, mode);
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
 * バックエンド未準備を表す明示エラー (ADR-0025 amendment: 自動フォールバックしない)。
 * - backend='local' だが localModel 未選択 / モデル未存在
 * - backend='external' だが apiKey 空
 * いずれも「選択済みバックエンドが未準備 = 接続無効」であり、他方へ暗黙に
 * 切り替えない。呼び出し元 (routes) はこれを捕捉して接続無効を返す。
 */
export class AgentBackendNotReadyError extends Error {
  readonly backend: 'external' | 'local';
  constructor(backend: 'external' | 'local', message: string) {
    super(message);
    this.name = 'AgentBackendNotReadyError';
    this.backend = backend;
  }
}

/**
 * backend='local' 時に解決したパラメータ (shim URL・ダミーキー・内蔵モデル名)。
 * agent-service だけが shim URL を組み立てないよう、routes/llm.ts の
 * localLlmBaseUrl() を唯一の baseUrl 導出点として使う。
 */
export interface LocalBackendResolution {
  /** OpenAI 互換 shim の baseUrl (<origin>/api/llm/v1)。 */
  baseUrl: string;
  /** shim は無認証 (in-process 同一オリジン)。pi SDK が要求するダミーキー。 */
  apiKey: string;
  /** 使用する内蔵モデルのファイル名 (.loamium/models/llm/ 配下)。 */
  model: string;
}

/**
 * バックエンド選択の解決結果。プロバイダ登録に必要な api/baseUrl/apiKey/model を返す。
 * ユーザーの明示選択に従い、未準備なら AgentBackendNotReadyError を投げる
 * (自動フォールバックしない = ADR-0025 amendment)。
 *
 * - backend 未指定 / 'external': 従来どおり config の baseUrl/apiKey/api/model。
 *   apiKey が空なら外部は未準備。
 * - backend='local': shim URL・ダミーキー・localModel。resolveLocalBackend が
 *   localModel 未選択 / モデル未存在なら AgentBackendNotReadyError を投げる。
 *
 * resolveLocalBackend は routes/agent-service の循環 import を避けるため注入する
 * (呼び出し元が localLlmBaseUrl + モデル存在チェックを渡す)。
 */
export interface ResolvedBackend {
  api: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveBackend(
  config: AgentConfig,
  resolveLocalBackend?: (localModel: string) => LocalBackendResolution,
): ResolvedBackend {
  const backend = config.backend ?? 'external';

  if (backend === 'local') {
    if (config.localModel === undefined || config.localModel === '') {
      throw new AgentBackendNotReadyError(
        'local',
        'local backend selected but no model chosen (config.localModel is unset)',
      );
    }
    if (resolveLocalBackend === undefined) {
      throw new AgentBackendNotReadyError(
        'local',
        'local backend selected but no resolver provided',
      );
    }
    // resolver がモデル未存在なら AgentBackendNotReadyError を投げる契約。
    const local = resolveLocalBackend(config.localModel);
    return { api: 'openai', baseUrl: local.baseUrl, apiKey: local.apiKey, model: local.model };
  }

  // external: apiKey 空なら未準備 (暗黙で local へ切り替えない)。
  if (config.apiKey === '') {
    throw new AgentBackendNotReadyError(
      'external',
      'external backend selected but apiKey is empty',
    );
  }
  return { api: config.api, baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model };
}

/**
 * 既定の local バックエンド resolver を生成する。
 * - baseUrl は routes/llm.ts の localLlmBaseUrl() から取る (唯一の導出点)。
 * - モデル存在チェック: .loamium/models/llm/<localModel> が実在しなければ
 *   AgentBackendNotReadyError を投げる (未存在なら local は未準備 = 接続無効)。
 * - 不正なファイル名も未準備扱い (パス封じ込めは resolveModelFilePath が担う)。
 */
export function makeLocalBackendResolver(
  vaultRoot: string,
): (localModel: string) => LocalBackendResolution {
  return (localModel: string): LocalBackendResolution => {
    let abs: string;
    try {
      abs = resolveModelFilePath(vaultRoot, 'llm', localModel);
    } catch (err) {
      if (err instanceof InvalidModelFilenameError) {
        throw new AgentBackendNotReadyError('local', `invalid local model name: ${localModel}`);
      }
      throw err;
    }
    if (!existsSync(abs)) {
      throw new AgentBackendNotReadyError(
        'local',
        `local model file not found: ${localModel} (.loamium/models/llm/)`,
      );
    }
    return {
      baseUrl: localLlmBaseUrl(),
      // shim は無認証 (in-process 同一オリジン)。pi SDK は非空キーを要求するためダミー。
      apiKey: 'local',
      model: localModel,
    };
  };
}

/**
 * プロバイダ登録済みの { authStorage, modelRegistry, model } を返す共通ヘルパー。
 * createPiSession / openPiSession の重複 ~25 行を統合する。
 *
 * ADR-0025 amendment (S8a3f2e-2 / AC-S8a3f2e-2-4): ユーザーが明示選択した
 * backend に従って登録する。backend='local' 時のみ baseUrl を shim URL・apiKey を
 * ダミーへ向け、'external' 時は従来どおり外部 baseUrl/apiKey を使う。未準備の
 * バックエンドは AgentBackendNotReadyError で接続無効とし、他方へ暗黙切替しない。
 * resolveLocalBackend は routes 側から注入する (循環 import を避ける)。
 */
function buildModelRegistry(
  config: AgentConfig,
  resolveLocalBackend?: (localModel: string) => LocalBackendResolution,
): {
  authStorage: ReturnType<typeof AuthStorage.inMemory>;
  modelRegistry: ReturnType<typeof ModelRegistry.inMemory>;
  model: ReturnType<ReturnType<typeof ModelRegistry.inMemory>['find']>;
} {
  const resolved = resolveBackend(config, resolveLocalBackend);
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  const providerName = `loamium-${resolved.api}-${Date.now()}`;
  const apiAdapter = resolved.api === 'openai' ? 'openai-completions' : 'anthropic-messages';
  modelRegistry.registerProvider(providerName, {
    api: apiAdapter,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    models: [
      {
        id: resolved.model,
        name: resolved.model,
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });

  // API キーを runtime override でセットする (auth.json 不要)
  authStorage.setRuntimeApiKey(providerName, resolved.apiKey);

  const model = modelRegistry.find(providerName, resolved.model);
  return { authStorage, modelRegistry, model };
}

/**
 * base システムプロンプトを注入する resourceLoader を生成する (S10a31c-1 / ADR-0014)。
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
 * index は vault 読み取りツール (ADR-0012) のクロージャへ渡す。
 * caps は実効ケーパビリティ (ADR-0015)。省略時は config.permissions の解決値
 * (未指定なら read-only プリセット)。呼び出し側 (routes) が LOAMIUM_MODE で
 * クランプ済みの集合を渡す想定。
 *
 * 副作用: 成功後 (sessionId 確定後) に caps をセッション権限ストアへ永続化する。
 */
export async function createPiSession(
  serverConfig: ServerConfig,
  config: AgentConfig,
  index: VaultIndex,
  caps?: Capability[],
): Promise<AgentSession> {
  const vaultRoot = serverConfig.vaultRoot;
  const effectiveCaps = caps ?? resolvePermissions(config.permissions);

  // ADR-0025 amendment: 明示選択された backend で登録する (未準備は投げる)。
  const { authStorage, modelRegistry, model } = buildModelRegistry(
    config,
    makeLocalBackendResolver(vaultRoot),
  );
  if (!model) {
    throw new Error(`model not found after registration: ${config.model}`);
  }

  const dir = sessionDir(vaultRoot);
  await fs.mkdir(dir, { recursive: true });

  const sm = SessionManager.create(vaultRoot, dir);

  // ADR-0018: 機密領域 deny リストをセッション生成時にロードし共通フィルタへ配線する。
  const { isDenied } = await loadAgentPrivacy(vaultRoot);
  // ADR-0012/0012: read ツール + (有効ケーパビリティに含まれる) 書き込みツールを連結する。
  // 書き込みツールは REST と同一の note-service を経由する (ADR-0016)。
  const customTools = [
    ...createVaultReadTools(index, vaultRoot, isDenied),
    ...createVaultWriteTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (agent-write-coverage): 添付ファイル file_write/file_move/file_delete。
    // file_write ケーパビリティが有効なときだけ広告 (REST と同一の file-service を経由)。
    ...createFileTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (Sc4b9d1-1): スマートフォルダ list/notes/write/delete。read で read 系 2 種、
    // smartfolder_write で write/delete を広告 (deriveToolNames と同じ effectiveCaps から導出)。
    ...createSmartFolderTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (Sc4b9d1-2): スマートコマンド commands_list (read) / command_run (command_run cap)。
    // command_run は REST と同一のステップ実行エンジン (commands-service.runCommand) を共有する。
    ...createCommandTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (Sc4b9d1-3): テンプレート templates_list (read) / template_instantiate
    // (template_write cap 再利用)。REST と同一の解決エンジン (templates-service) を共有する。
    // ADR-0018: agent 経路として isDenied を渡し、解決保存先の機密領域 deny を強制する。
    // ADR-0031: VaultIndex を渡して select+optionsQuery の厳格 select 検証を有効化。
    ...createTemplateTools(serverConfig, isDenied, effectiveCaps, index),
    // ADR-0017: web が有効ケーパビリティに含まれるときだけ web_fetch / web_search を追加。
    // allowPrivate は本番既定 false (SSRF 防止)。
    ...createVaultWebTools(serverConfig, config, effectiveCaps),
    // S7e2d5c-1: vault_seed ケーパビリティが有効なとき vault_seed ツールを追加 (SeedService 経由)。
    ...createVaultSeedTool(serverConfig, effectiveCaps),
  ];
  const resourceLoader = await buildAgentResourceLoader(vaultRoot);

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: sm,
    // ADR-0014: Loamium がコードで生成した base システムプロンプトを注入する。
    resourceLoader,
    // ADR-0012/0011: 有効ケーパビリティから allowlist を導出し LLM 広告ツールを制御する。
    // noTools:'all' は customTools も含め全ツールを抑制するため使用しない。
    // tools に allowlist を渡すことで built-in を排除しカスタムツールのみ広告される。
    // excludeTools は defense-in-depth — allowlist 変更時でも組み込みが漏れない。
    // (pi-coding-agent/dist/core/sdk.js:132-135, agent-session.js:1916)
    //
    // S5bd678 Story 2 (ADR-0016): customTools は read 系 6 種 + help に加え、有効
    // ケーパビリティに含まれる書き込みツール (note_create 等) を含む。書き込みツールは
    // REST と同一の note-service を経由する。allowlist (deriveToolNames) と customTools の
    // 両方が同じ effectiveCaps から導出されるため、広告と実行の集合が一致する。
    tools: deriveToolNames(effectiveCaps),
    excludeTools: [...PI_BUILTIN_TOOL_NAMES],
    customTools: [...customTools],
  });

  activeSessionsById.set(session.sessionId, session);

  // sessionId 確定後にセッション権限を永続化する (再オープン時に同じツール集合を導出)。
  await saveSessionPerms(vaultRoot, session.sessionId, effectiveCaps);

  return session;
}

/**
 * 既存セッションを開く (disk-backed。AgentSession はファイルから復元)。
 * config は遅延読込済みを渡す。
 * index は vault 読み取りツール (ADR-0012) のクロージャへ渡す。
 * mode はサーバー LOAMIUM_MODE。セッション権限ストアからロードした caps を
 * mode でクランプして allowlist を導出する (ADR-0015)。
 *
 * セッション権限ストアにエントリが無い (再起動前の古いセッション等) 場合は
 * config.permissions 既定へフォールバックする。これにより再オープン後も
 * 作成時と同じツール集合を導出できる (サーバー再起動含む)。
 */
export async function openPiSession(
  sessionFile: string,
  serverConfig: ServerConfig,
  config: AgentConfig,
  index: VaultIndex,
): Promise<AgentSession> {
  const vaultRoot = serverConfig.vaultRoot;
  const mode = serverConfig.mode;
  // 既に active なら再利用
  const existingSessionId = getSessionIdFromFile(sessionFile);
  if (existingSessionId) {
    const existing = activeSessionsById.get(existingSessionId);
    if (existing) return existing;
  }

  // セッション権限ストアからケーパビリティを復元 (無ければ config 既定)。
  const sessionPerms = existingSessionId
    ? await loadSessionPerms(vaultRoot, existingSessionId)
    : null;
  const effectiveCaps = getEffectiveCapabilities(config, sessionPerms, mode);

  // ADR-0025 amendment: 明示選択された backend で登録する (未準備は投げる)。
  const { authStorage, modelRegistry, model } = buildModelRegistry(
    config,
    makeLocalBackendResolver(vaultRoot),
  );
  if (!model) throw new Error(`model not found: ${config.model}`);

  const dir = sessionDir(vaultRoot);
  const sm = SessionManager.open(sessionFile, dir);

  // ADR-0018: 同上 — 既存セッションを開くたびに最新の deny リストを反映する。
  const { isDenied } = await loadAgentPrivacy(vaultRoot);
  // ADR-0012/0012: read + 書き込みツール (復元した実効ケーパビリティ分のみ広告)。
  const customTools = [
    ...createVaultReadTools(index, vaultRoot, isDenied),
    ...createVaultWriteTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (agent-write-coverage): 復元した実効ケーパビリティに応じて添付ファイルツールを追加。
    ...createFileTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (Sc4b9d1-1): 復元した実効ケーパビリティに応じてスマートフォルダツールを追加。
    ...createSmartFolderTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (Sc4b9d1-2): 復元した実効ケーパビリティに応じてスマートコマンドツールを追加。
    ...createCommandTools(serverConfig, index, isDenied, effectiveCaps),
    // ADR-0016 (Sc4b9d1-3): 復元した実効ケーパビリティに応じてテンプレートツールを追加。
    // ADR-0018: agent 経路として isDenied を渡し、解決保存先の機密領域 deny を強制する。
    // ADR-0031: VaultIndex を渡して select+optionsQuery の厳格 select 検証を有効化。
    ...createTemplateTools(serverConfig, isDenied, effectiveCaps, index),
    // ADR-0017: 復元した実効ケーパビリティに web が含まれるときだけ web ツールを追加。
    ...createVaultWebTools(serverConfig, config, effectiveCaps),
    // S7e2d5c-1: 復元した実効ケーパビリティに vault_seed が含まれるとき vault_seed ツールを追加。
    ...createVaultSeedTool(serverConfig, effectiveCaps),
  ];
  const resourceLoader = await buildAgentResourceLoader(vaultRoot);

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: sm,
    // ADR-0014: 同上 — base システムプロンプトを注入する。
    resourceLoader,
    // ADR-0012/0011/0012: 復元した実効ケーパビリティから allowlist を導出し、
    // 同じ集合から read + 書き込み customTools を生成する (広告と実行が一致)。
    tools: deriveToolNames(effectiveCaps),
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
 * active キャッシュからセッションを退避する (ファイルは消さない)。
 *
 * セッション中の権限変更 (PUT permissions) 後に呼ぶ。次のメッセージ送信時に
 * getSessionFromDisk → openPiSession が session-perms を再ロードし、新しい
 * ケーパビリティ集合でセッションを再オープンする (ツール allowlist を更新)。
 */
export function evictActiveSession(sessionId: string): void {
  activeSessionsById.delete(sessionId);
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
  serverConfig: ServerConfig,
  config: AgentConfig,
  index: VaultIndex,
): Promise<AgentSession> {
  const vaultRoot = serverConfig.vaultRoot;
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

  return openPiSession(info.path, serverConfig, config, index);
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
  reasoning?: string;
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
      const reasoning = extractReasoning(msg.content);
      // 推論モデルは text 本文なし(thinking のみ)で応答を終えることがある。
      // そのターンをスキップすると復元時に空欄になり「反応しない」ように見えるため、
      // reasoning があれば復元対象に含める。
      if (textContent || toolUses.length > 0 || reasoning) {
        msgs.push({
          role: 'assistant',
          content: textContent,
          tools: toolUses.map((t) => ({
            name: t.name,
            argsSummary: t.argsSummary,
            status: 'done' as const,
          })),
          ...(reasoning ? { reasoning } : {}),
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

/** メッセージのコンテンツ配列から thinking(推論)ブロックのテキストを連結して抽出する。 */
function extractReasoning(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'thinking'; thinking: string } =>
      typeof c === 'object' &&
      c !== null &&
      (c as Record<string, unknown>)['type'] === 'thinking' &&
      typeof (c as Record<string, unknown>)['thinking'] === 'string',
    )
    .map((c) => c.thinking)
    .join('');
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
 * セッション履歴を指定したユーザーメッセージインデックス以降で切り捨てる。
 *
 * pi SDK の sessionManager.branch() を使ってリーフポインタを巻き戻し、
 * agent.state.messages も最新のセッションコンテキストで更新する。
 * (navigateTree のセルフ実装: ツリーUIが不要なため最小実装で代替)
 *
 * @param session - 対象の AgentSession
 * @param fromUserMessageIndex - 0 始まり。このインデックスのユーザーメッセージ以降を削除
 * @returns 切り捨て後のユーザーメッセージ数
 * @throws Error - インデックスが範囲外、またはセッションのエントリが取得できない場合
 */
export function truncateSessionMessages(
  session: AgentSession,
  fromUserMessageIndex: number,
): number {
  // アクティブブランチのエントリを取得 (リーフからルートへのチェーン)
  const branchEntries = session.sessionManager.getBranch();

  // ユーザーメッセージエントリを出現順に収集 (SessionMessageEntry 型で絞り込む)
  const userMessageEntries = branchEntries.filter(
    (e): e is SessionMessageEntry =>
      e.type === 'message' &&
      typeof e.message === 'object' &&
      e.message !== null &&
      (e.message as { role?: unknown }).role === 'user',
  );

  if (fromUserMessageIndex >= userMessageEntries.length) {
    throw new Error(
      `fromUserMessageIndex ${String(fromUserMessageIndex)} is out of range (total user messages: ${String(userMessageEntries.length)})`,
    );
  }

  // 切り捨て対象ユーザーメッセージエントリの直前エントリが新しいリーフになる
  const targetEntry = userMessageEntries[fromUserMessageIndex];
  if (!targetEntry) {
    throw new Error(`Cannot find entry at fromUserMessageIndex ${String(fromUserMessageIndex)}`);
  }

  // 対象ユーザーメッセージの親エントリ ID が新しいリーフ (null = ルート)
  // SessionEntryBase.parentId: string | null
  const newLeafId: string | null = targetEntry.parentId;

  if (newLeafId === null) {
    // ルートへ巻き戻す
    session.sessionManager.resetLeaf();
  } else {
    // 親エントリへ巻き戻す (branch はリーフポインタを変更するだけでエントリは削除しない)
    session.sessionManager.branch(newLeafId);
  }

  // agent.state.messages をセッションコンテキストで同期する
  const sessionContext = session.sessionManager.buildSessionContext();
  session.agent.state.messages = sessionContext.messages;

  // 切り捨て後のユーザーメッセージ数 = fromUserMessageIndex 個
  return fromUserMessageIndex;
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
