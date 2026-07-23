/**
 * REST API クライアント。リクエスト/レスポンスは shared の zod スキーマで検証する
 * (DESIGN_PRINCIPLES coding_conventions: スキーマ検証 + 型共有)。
 */
import { z } from 'zod';
import {
  backlinksResponseSchema,
  fileDeleteResponseSchema,
  fileListResponseSchema,
  fileRenameResponseSchema,
  fileWriteResponseSchema,
  healthResponseSchema,
  journalResponseSchema,
  noteDeleteResponseSchema,
  noteListResponseSchema,
  noteMetaResponseSchema,
  noteRenameResponseSchema,
  notePropertyWriteRequestSchema,
  noteResponseSchema,
  noteWriteResponseSchema,
  errorResponseSchema,
  parsePropertyTypesJson,
  propertyKeysResponseSchema,
  propertyTypesResponseSchema,
  propertyTypeWriteResponseSchema,
  queryErrorResponseSchema,
  queryResponseSchema,
  searchResponseSchema,
  smartFoldersResolveResponseSchema,
  smartViewConfigSchema,
  tagsResponseSchema,
  templateInstantiateResponseSchema,
  templatesResponseSchema,
  commandsResponseSchema,
  commandRunResponseSchema,
  commandSourceResponseSchema,
  commandSourceWriteResponseSchema,
  systemFileListResponseSchema,
  systemFileSourceResponseSchema,
  systemFileSourceWriteResponseSchema,
  systemFileDeleteResponseSchema,
  appSettingsResponseSchema,
  agentConnectionResponseSchema,
  agentPermissionsResponseSchema,
  agentPrivacySettingsResponseSchema,
  agentConnectionTestResponseSchema,
  agentModelsResponseSchema,
  agentConnectionWriteResponseSchema,
  agentPermissionsWriteResponseSchema,
  taskVocabResponseSchema,
  taskVocabWriteResponseSchema,
  optionsQueryResponseSchema,
  type TemplateInstantiateResponse,
  type TemplateSummary,
  type PropertyKeyCount,
  type PropertyTypeDef,
  type SelectOption,
  type SmartFoldersResolveResponse,
  type SmartViewConfig,
  type TagsResponse,
  type BacklinksResponse,
  type FileDeleteResponse,
  type FileListResponse,
  type FileRenameResponse,
  type FileWriteResponse,
  type HealthResponse,
  type JournalResponse,
  type NoteDeleteResponse,
  type NoteListResponse,
  type NoteMetaResponse,
  type NoteRenameResponse,
  type NotePropertyWriteRequest,
  type NoteResponse,
  type NoteWriteResponse,
  type QueryResponse,
  type SearchResponse,
  type CommandRunResponse,
  type CommandSourceResponse,
  type CommandSourceWriteResponse,
  type OptionsQueryResponse,
  type SystemFileListResponse,
  type SystemFileSourceResponse,
  type SystemFileSourceWriteResponse,
  type SystemFileDeleteResponse,
  type CommandSummary,
  type AppSettings,
  type AgentConnectionResponse,
  type AgentPermissionsResponse,
  type AgentPrivacySettingsResponse,
  type AgentConnectionTestResponse,
  type AgentModelsResponse,
  type AgentConnectionTestRequest,
  agentJobListResponseSchema,
  agentJobRunResponseSchema,
  type AgentJob,
  type AgentJobState,
  type AgentJobWithState,
  type AgentJobListResponse,
  type AgentJobRunResponse,
  localModelListResponseSchema,
  localModelDownloadAcceptedResponseSchema,
  localModelDownloadStatusResponseSchema,
  localModelDeleteResponseSchema,
  type AgentBackend,
  type LocalModelListResponse,
  type LocalModelDownloadAcceptedResponse,
  type LocalModelDownloadStatusResponse,
  type LocalModelDeleteResponse,
  type TaskVocabRequired,
} from '@loamium/shared';

// ---- エージェントジョブ型を再エクスポート (S2fe109) ----
export type { AgentJob, AgentJobState, AgentJobWithState, AgentJobListResponse, AgentJobRunResponse };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * DQL 構文エラー (POST /api/query の 400 query_syntax — Sb1593c-2)。
 * 位置情報 (1 始まり行・列 + トークン長) を持ち、dataview フェンスの
 * キャレット付きエラー表示が使う。
 */
export class QueryApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly line: number,
    readonly column: number,
    readonly length: number,
  ) {
    super(status, code, message);
    this.name = 'QueryApiError';
  }
}

/** vault 相対パスをセグメント単位で percent-encode する (日本語・スペース対応)。 */
export function encodeNotePath(rel: string): string {
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

async function request<S extends z.ZodTypeAny>(
  schema: S,
  url: string,
  init?: RequestInit,
): Promise<z.infer<S>> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let code = 'http_error';
    let message = `HTTP ${res.status}`;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (err) {
      // 非 JSON のエラーボディ (proxy エラー等) は既定メッセージのまま扱う
      void err;
    }
    const parsed = errorResponseSchema.safeParse(body);
    if (parsed.success) {
      code = parsed.data.error;
      message = parsed.data.message;
    }
    throw new ApiError(res.status, code, message);
  }
  const data: unknown = await res.json();
  return schema.parse(data) as z.infer<S>;
}

/**
 * GET /api/events の URL を返す (useVaultEvents フック用)。
 * テストではこの関数をモックして別 URL を差し込める。
 */
export function getVaultEventsUrl(): string {
  return '/api/events';
}

export const api = {
  /** GET /api/health — サーバーモード等を取得。 */
  getHealth(): Promise<HealthResponse> {
    return request(healthResponseSchema, '/api/health');
  },

  /**
   * 意味型スキーマ (.loamium/property-types.json) を取得する (S87f4b7-2)。
   * 生 JSON を検証済みの「キー → 型定義」へ変換して返す。壊れていても
   * parsePropertyTypesJson が妥当なエントリだけ採用しクラッシュしない (AC-2-3)。
   */
  async getPropertyTypes(): Promise<Record<string, PropertyTypeDef>> {
    const res = await request(propertyTypesResponseSchema, '/api/property-types');
    return parsePropertyTypesJson(res.types);
  },

  /**
   * vault 横断のプロパティキー集約 (GET /api/property-keys — Sd13ab1-2)。
   * 全ノートの frontmatter トップレベルキーを件数付きで返す (件数降順→キー昇順)。
   * キーファースト追加メニュー zone ① の vault 実使用キー候補に使う。
   */
  async getPropertyKeys(): Promise<PropertyKeyCount[]> {
    const res = await request(propertyKeysResponseSchema, '/api/property-keys');
    return res.keys;
  },

  /**
   * 新規プロパティの汎用型を .loamium/property-types.json へ永続化する
   * (PUT /api/property-types — Sd13ab1-2, D方式の横断固定)。返り値は妥当性検証済みの
   * 「キー → 型定義」全体 (以後の解決に使う)。
   */
  async putPropertyType(
    key: string,
    def: { type: PropertyTypeDef['type']; options?: (string | SelectOption)[] },
  ): Promise<Record<string, PropertyTypeDef>> {
    const res = await request(propertyTypeWriteResponseSchema, '/api/property-types', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, def }),
    });
    return parsePropertyTypesJson(res.types);
  },

  listNotes(): Promise<NoteListResponse> {
    return request(noteListResponseSchema, '/api/notes');
  },

  getNote(path: string): Promise<NoteResponse> {
    return request(noteResponseSchema, `/api/notes/${encodeNotePath(path)}`);
  },

  /** ノート 1 件のメタ情報 (見出し・タグ・frontmatter 等) を取得する (S11493d-1)。 */
  getNoteMeta(path: string): Promise<NoteMetaResponse> {
    return request(noteMetaResponseSchema, `/api/notes/${encodeNotePath(path)}/meta`);
  },

  putNote(path: string, content: string, baseMtime?: number): Promise<NoteWriteResponse> {
    const body: { content: string; baseMtime?: number } = { content };
    if (baseMtime !== undefined) body.baseMtime = baseMtime;
    return request(noteWriteResponseSchema, `/api/notes/${encodeNotePath(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  deleteNote(path: string): Promise<NoteDeleteResponse> {
    return request(noteDeleteResponseSchema, `/api/notes/${encodeNotePath(path)}`, {
      method: 'DELETE',
    });
  },

  getJournal(date?: string): Promise<JournalResponse> {
    const qs = date !== undefined ? `?date=${encodeURIComponent(date)}` : '';
    return request(journalResponseSchema, `/api/journal${qs}`);
  },

  getBacklinks(path: string): Promise<BacklinksResponse> {
    return request(backlinksResponseSchema, `/api/backlinks?path=${encodeURIComponent(path)}`);
  },

  search(q: string): Promise<SearchResponse> {
    return request(searchResponseSchema, `/api/search?q=${encodeURIComponent(q)}`);
  },

  /** タグ一覧 (件数付き — S45fa45 のタグ補完ソース)。件数降順→タグ昇順で返る。 */
  getTags(): Promise<TagsResponse> {
    return request(tagsResponseSchema, '/api/tags');
  },

  /**
   * dataview 風 DQL クエリ (POST /api/query — Sb1593c)。
   * 構文エラー (400 query_syntax) は位置情報付きの QueryApiError で送出する。
   */
  async query(dql: string): Promise<QueryResponse> {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: dql }),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch (err) {
        void err; // 非 JSON のエラーボディは既定メッセージのまま扱う
      }
      const positioned = queryErrorResponseSchema.safeParse(body);
      if (positioned.success) {
        const e = positioned.data;
        throw new QueryApiError(res.status, e.error, e.message, e.line, e.column, e.length);
      }
      const parsed = errorResponseSchema.safeParse(body);
      if (parsed.success) {
        throw new ApiError(res.status, parsed.data.error, parsed.data.message);
      }
      throw new ApiError(res.status, 'http_error', `HTTP ${String(res.status)}`);
    }
    return queryResponseSchema.parse(await res.json());
  },

  renameNote(path: string, newPath: string): Promise<NoteRenameResponse> {
    return request(noteRenameResponseSchema, `/api/notes/${encodeNotePath(path)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPath }),
    });
  },

  // ---- 添付ファイル (Sf53ad6) ----

  listFiles(): Promise<FileListResponse> {
    return request(fileListResponseSchema, '/api/files');
  },

  uploadFile(path: string, data: Blob | ArrayBuffer, overwrite = false): Promise<FileWriteResponse> {
    const qs = overwrite ? '?overwrite=true' : '';
    return request(fileWriteResponseSchema, `/api/files/${encodeNotePath(path)}${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
    });
  },

  deleteFile(path: string): Promise<FileDeleteResponse> {
    return request(fileDeleteResponseSchema, `/api/files/${encodeNotePath(path)}`, {
      method: 'DELETE',
    });
  },

  renameFile(path: string, newPath: string): Promise<FileRenameResponse> {
    return request(fileRenameResponseSchema, `/api/files/${encodeNotePath(path)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPath }),
    });
  },

  // ---- フロントマタープロパティ書込 (S8086d9-2 — POST /api/notes/{path}/properties) ----

  /**
   * ノートの frontmatter プロパティを部分的に書き換える (set / unset)。
   * レスポンスの `mtime` は任意 (モックテストとの互換のため)。
   */
  setNoteProperties(path: string, body: NotePropertyWriteRequest) {
    const responseSchema = z.object({
      path: z.string(),
      frontmatter: z.record(z.string(), z.unknown()).nullable(),
      mtime: z.number().optional(),
    });
    return request(
      responseSchema,
      `/api/notes/${encodeNotePath(path)}/properties`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(notePropertyWriteRequestSchema.parse(body)),
      },
    );
  },

  // ---- スマートフォルダ (S8086d9-1) ----

  /** スマートフォルダ定義一式 (GET /api/smart-folders)。 */
  listSmartFolders(): Promise<SmartViewConfig> {
    return request(smartViewConfigSchema, '/api/smart-folders');
  },

  /** スマートフォルダ定義一式を保存 (PUT /api/smart-folders — S7b2f22-1)。 */
  putSmartFolders(config: SmartViewConfig): Promise<SmartViewConfig> {
    return request(smartViewConfigSchema, '/api/smart-folders', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
  },

  /** スマートフォルダのノート解決 (GET /api/smart-folders/{id}/notes)。 */
  resolveSmartFolder(id: string): Promise<SmartFoldersResolveResponse> {
    return request(smartFoldersResolveResponseSchema, `/api/smart-folders/${encodeURIComponent(id)}/notes`);
  },

  // ---- 汎用テンプレート (S89a350-3) ----

  /** テンプレート一覧 (GET /api/templates)。target / vars 付き。 */
  async listTemplates(): Promise<TemplateSummary[]> {
    const res = await request(templatesResponseSchema, '/api/templates');
    return res.templates;
  },

  /**
   * ノートエクスポート URL を構築する (GET /api/notes/{path}/export?format=...) (Sa8ee62-2)。
   * 実際の fetch は呼び出し元 (fetch → Blob → createObjectURL) で行う。
   * format: 'pdf' | 'html'
   */
  exportNoteUrl(path: string, format: 'pdf' | 'html'): string {
    return `/api/notes/${encodeNotePath(path)}/export?format=${encodeURIComponent(format)}`;
  },

  /**
   * テンプレートをインスタンス化する (POST /api/templates/{name}/instantiate)。
   * 不足変数は ApiError(status 400, code 'missing_vars') で送出する。
   * date は {{date:...}} の基準日を上書きする (YYYY-MM-DD)。
   */
  instantiateTemplate(
    name: string,
    vars: Record<string, string>,
    date?: string,
  ): Promise<TemplateInstantiateResponse> {
    const body: { vars: Record<string, string>; date?: string } = { vars };
    if (date !== undefined) body.date = date;
    const encoded = name
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return request(templateInstantiateResponseSchema, `/api/templates/${encoded}/instantiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  // ---- スマートコマンド (Sde7a63-1 / Sde7a63-3) ----

  /**
   * スマートコマンド一覧を取得する (GET /api/commands — Sd22b1f-1)。
   * valid:true の定義は params 付き、valid:false は error 付きで返る。
   */
  async listCommands(): Promise<CommandSummary[]> {
    const res = await request(commandsResponseSchema, '/api/commands');
    return res.commands;
  },

  /**
   * 動的候補取得 (POST /api/options-query — S1bd397-1)。
   * dql: LIST クエリ文字列。resolvedVars: 依存クエリ用変数マップ (任意)。topN: 上限件数 (任意)。
   */
  async queryOptions(
    dql: string,
    resolvedVars?: Record<string, string>,
    topN?: number,
  ): Promise<OptionsQueryResponse> {
    const body: Record<string, unknown> = { dql };
    if (resolvedVars !== undefined) body['resolvedVars'] = resolvedVars;
    if (topN !== undefined) body['topN'] = topN;
    const res = await fetch('/api/options-query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errBody: unknown = null;
      try { errBody = await res.json(); } catch { /* ignore */ }
      const parsed = errorResponseSchema.safeParse(errBody);
      if (parsed.success) throw new ApiError(res.status, parsed.data.error, parsed.data.message);
      throw new ApiError(res.status, 'http_error', `HTTP ${String(res.status)}`);
    }
    return optionsQueryResponseSchema.parse(await res.json());
  },

  /**
   * スマートコマンドを実行する (POST /api/commands/{name}/run — Sd22b1f-2)。
   * params: コマンドパラメータの名前→値マップ。
   * レスポンスは commandRunResponseSchema で検証する。
   */
  runCommand(name: string, params: Record<string, string>): Promise<CommandRunResponse> {
    return request(commandRunResponseSchema, `/api/commands/${encodeURIComponent(name)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params }),
    });
  },

  /**
   * コマンド定義ファイルの生 YAML を取得する (GET /api/commands/{id}/source)。
   * notes API の .md 強制を回避し、commands/*.yaml を正しく読む。
   * id = ファイルの stem (拡張子なし)。例: "create-todo"
   */
  getCommandSource(id: string): Promise<CommandSourceResponse> {
    return request(commandSourceResponseSchema, `/api/commands/${encodeURIComponent(id)}/source`);
  },

  /**
   * system/ 配下の全設定ファイル (yaml + md) をフォルダ構造付きで列挙する
   * (GET /api/system-files — Sa10026-9 #1)。settings.yaml / smart-folders/*.yaml /
   * templates/*.md / commands/*.yaml を含む。取得失敗時は空リスト (graceful degradation)。
   */
  async listSystemFiles(): Promise<SystemFileListResponse> {
    try {
      return await request(systemFileListResponseSchema, '/api/system-files');
    } catch {
      return { files: [] };
    }
  },

  /**
   * system/ 配下ファイルの生テキストを取得する (GET /api/system-files/{path}/source)。
   * notes API の .md 強制を回避し、yaml / md を同じ経路で読む。
   */
  getSystemFileSource(path: string): Promise<SystemFileSourceResponse> {
    return request(systemFileSourceResponseSchema, `/api/system-files/${encodeNotePath(path)}/source`);
  },

  /**
   * system/ 配下ファイルへ生テキストを書き込む (PUT /api/system-files/{path}/source)。
   * mtime: 楽観的競合検出 (省略時は無条件上書き)。
   */
  putSystemFileSource(path: string, content: string, mtime?: number): Promise<SystemFileSourceWriteResponse> {
    const body: { content: string; mtime?: number } = { content };
    if (mtime !== undefined) body.mtime = mtime;
    return request(systemFileSourceWriteResponseSchema, `/api/system-files/${encodeNotePath(path)}/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /**
   * system/ 配下ファイルを削除する (DELETE /api/system-files/{path}/source)。
   * agent 非公開・監査ログ記録・mode クランプ済み (Sa100c6-1 AC-3)。
   */
  deleteSystemFile(path: string): Promise<SystemFileDeleteResponse> {
    return request(systemFileDeleteResponseSchema, `/api/system-files/${encodeNotePath(path)}/source`, {
      method: 'DELETE',
    });
  },

  /**
   * アプリ全体設定を取得する (GET /api/settings/system — Sa10026-3/-5)。
   * 404 / 接続エラーの場合は既定値 { defaultFolder: '' } を返す (graceful degradation)。
   * [AC-Sa10026-8-2]
   */
  async getSystemSettings(): Promise<AppSettings> {
    try {
      const res = await request(appSettingsResponseSchema, '/api/settings/system');
      return res.settings;
    } catch {
      // 設定取得失敗時 (Sa10026-5 未実装環境など) は既定値で動く
      return { theme: 'system', defaultFolder: '', journalTemplate: 'system/templates/journal.md', showSystemFolder: false };
    }
  },

  /**
   * コマンド定義ファイルの生 YAML を書き込む (PUT /api/commands/{id}/source)。
   * notes API の .md 強制を回避し、commands/*.yaml に正しく書き込む。
   * mtime: 楽観的競合検出 (省略時は無条件上書き)。
   */
  putCommandSource(id: string, content: string, mtime?: number): Promise<CommandSourceWriteResponse> {
    const body: { content: string; mtime?: number } = { content };
    if (mtime !== undefined) body.mtime = mtime;
    return request(commandSourceWriteResponseSchema, `/api/commands/${encodeURIComponent(id)}/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  // ---- 設定 API (Sa10026-7) ----

  /**
   * アプリ全体設定を保存する (PUT /api/settings/system)。
   * [AC-Sa10026-7-1]
   */
  putSystemSettings(settings: AppSettings): Promise<{ settings: AppSettings }> {
    return request(appSettingsResponseSchema, '/api/settings/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
  },

  /**
   * agent 接続設定を取得する (GET /api/settings/agent/connection)。
   * apiKey は $ENV_VAR 参照名 (apiKeyRef) として返る。実値は含まれない。
   * [AC-Sa10026-7-1] [AC-Sa10026-7-3]
   */
  getAgentConnection(): Promise<AgentConnectionResponse> {
    return request(agentConnectionResponseSchema, '/api/settings/agent/connection');
  },

  /**
   * agent 接続設定を保存する (PUT /api/settings/agent/connection)。
   * apiKey は直値 (sk-... 等) または $ENV_VAR 参照名を渡す。
   * apiKey を省略すると、サーバーは既存の apiKey を維持する (上書きしない)。
   * [AC-Sa10026-7-1]
   */
  putAgentConnection(params: {
    api: 'openai' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** 推論バックエンド (S8a3f2e-4)。省略時はサーバーが既存値を維持。 */
    backend?: AgentBackend;
    /** ローカルモデル名 (S8a3f2e-4): string=選択, null=クリア, 省略=維持。 */
    localModel?: string | null;
  }): Promise<{ ok: boolean }> {
    return request(agentConnectionWriteResponseSchema, '/api/settings/agent/connection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  // ---- 内蔵ローカル LLM モデル管理 (S8a3f2e-4) ------------------------------

  /**
   * .loamium/models/llm/ の取得済みモデル一覧を取得する (GET /api/llm/models)。
   */
  getLlmModels(): Promise<LocalModelListResponse> {
    return request(localModelListResponseSchema, '/api/llm/models');
  },

  /**
   * GGUF モデルのダウンロードを開始する (POST /api/llm/models/download)。
   * ポーリング用の id を返す。read-only/append-only では 403。
   */
  downloadLlmModel(params: { url: string; filename?: string }): Promise<LocalModelDownloadAcceptedResponse> {
    return request(localModelDownloadAcceptedResponseSchema, '/api/llm/models/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  /**
   * ダウンロードジョブの進捗を取得する (GET /api/llm/models/download/:id/status)。
   */
  getLlmDownloadStatus(id: string): Promise<LocalModelDownloadStatusResponse> {
    return request(
      localModelDownloadStatusResponseSchema,
      `/api/llm/models/download/${encodeURIComponent(id)}/status`,
    );
  },

  /**
   * ローカルモデルを削除する (DELETE /api/llm/models/:filename)。
   * read-only/append-only では 403。
   */
  deleteLlmModel(filename: string): Promise<LocalModelDeleteResponse> {
    return request(
      localModelDeleteResponseSchema,
      `/api/llm/models/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    );
  },

  /**
   * agent 権限・capability を取得する (GET /api/settings/agent/permissions)。
   * [AC-Sa10026-7-1]
   */
  getAgentPermissions(): Promise<AgentPermissionsResponse> {
    return request(agentPermissionsResponseSchema, '/api/settings/agent/permissions');
  },

  /**
   * agent 権限を保存する (PUT /api/settings/agent/permissions)。
   * [AC-Sa10026-7-1]
   */
  putAgentPermissions(permissions: string | string[]): Promise<{ ok: boolean }> {
    return request(agentPermissionsWriteResponseSchema, '/api/settings/agent/permissions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions }),
    });
  },

  /**
   * agent 機密領域 deny-list を取得する (GET /api/settings/agent/privacy)。
   * [AC-Sa10026-7-1]
   */
  getAgentPrivacy(): Promise<AgentPrivacySettingsResponse> {
    return request(agentPrivacySettingsResponseSchema, '/api/settings/agent/privacy');
  },

  /**
   * agent 機密領域 deny-list を保存する (PUT /api/settings/agent/privacy)。
   * 実サーバーは保存後の deny-list ({ deny }) をそのまま返す
   * (agentPrivacySettingsResponseSchema と同形。書込専用の { ok } ではない)。
   * [AC-Sa10026-7-1]
   */
  putAgentPrivacy(deny: string[]): Promise<AgentPrivacySettingsResponse> {
    return request(agentPrivacySettingsResponseSchema, '/api/settings/agent/privacy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deny }),
    });
  },

  /**
   * agent 接続テスト (POST /api/settings/agent/connection/test)。
   * 接続結果を ok/error で返す。apiKey 実値はレスポンスに含まれない。
   * [AC-Sa10026-7-1]
   */
  testAgentConnection(params: AgentConnectionTestRequest): Promise<AgentConnectionTestResponse> {
    return request(agentConnectionTestResponseSchema, '/api/settings/agent/connection/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  /**
   * agent モデル一覧を取得する (GET /api/settings/agent/models)。
   * 取得失敗時は source:'fallback' で空リストが返る (直接入力は引き続き可能)。
   * [AC-Sa10026-7-1]
   */
  getAgentModels(): Promise<AgentModelsResponse> {
    return request(agentModelsResponseSchema, '/api/settings/agent/models');
  },

  // ---- タスク行パッチ (Se3b7a2) ----------------------------------------

  /**
   * ノートの 1 行テキストを置換する (POST /api/notes/{path}/patch)。
   * old が見つからない / 複数ある → 409。呼び出し元が ApiError.status===409 を検査する。
   * [AC-Se3b7a2-2-1]
   */
  patchNote(
    path: string,
    oldLine: string,
    newLine: string,
  ): Promise<{ ok: boolean; path: string; mtime: number }> {
    return request(
      z.object({ ok: z.boolean(), path: z.string(), mtime: z.number() }),
      `/api/notes/${encodeNotePath(path)}/patch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ old: oldLine, new: newLine }),
      },
    );
  },

  // ---- タスク語彙設定 (Se3b7a2-8) ----------------------------------------

  /**
   * タスク語彙 (statuses / priorities) を取得する (GET /api/settings/tasks)。
   * 設定がなければ DEFAULT_TASK_VOCAB を返す。
   * [AC-Se3b7a2-8-1]
   */
  async getTaskVocab(): Promise<TaskVocabRequired> {
    const res = await request(taskVocabResponseSchema, '/api/settings/tasks');
    return res.vocab;
  },

  /**
   * タスク語彙を保存する (PUT /api/settings/tasks)。
   * [AC-Se3b7a2-8-2]
   */
  putTaskVocab(vocab: TaskVocabRequired): Promise<{ ok: boolean }> {
    return request(taskVocabWriteResponseSchema, '/api/settings/tasks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vocab }),
    });
  },

  // ---- エージェントジョブ (S2fe109) ----------------------------------------

  getAgentJobs(): Promise<AgentJobListResponse> {
    return request(agentJobListResponseSchema, '/api/agent/jobs');
  },

  putAgentJobs(jobs: AgentJob[]): Promise<{ ok: boolean; count: number }> {
    return request(
      z.object({ ok: z.boolean(), count: z.number() }),
      '/api/agent/jobs',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobs }) },
    );
  },

  runAgentJob(name: string): Promise<AgentJobRunResponse> {
    return request(agentJobRunResponseSchema, `/api/agent/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });
  },
};
