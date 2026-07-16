/**
 * REST API のリクエスト/レスポンス zod スキーマ。
 * server と (将来の) cli / ui で共有する (DESIGN_PRINCIPLES coding_conventions)。
 */
import { z } from 'zod';
import { normalizeVaultFilePath, VaultPathError } from './path.js';
import { parseQuery, DqlParseError } from './dql.js';
import { commandParamSchema } from './loamium-command.js';
import { AGENT_CAPABILITIES, agentPermissionsSchema } from './agent-capabilities.js';
import { appSettingsSchema } from './system-definitions.js';

// ---- 権限モード ----

export const permissionModeSchema = z.enum(['full', 'read-only', 'append-only']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

// ---- リクエスト ----

export const noteWriteRequestSchema = z.object({
  content: z.string(),
  /**
   * 楽観的競合検出 (SPEC §9 高-1 / ARCHITECTURE: last-write-wins + mtime)。
   * 指定時、対象ファイルの現 mtime (ms epoch) と不一致なら 409 conflict。
   * 省略時は無条件で上書き (last-write-wins)。
   */
  baseMtime: z.number().int().nonnegative().optional(),
});
export type NoteWriteRequest = z.infer<typeof noteWriteRequestSchema>;

export const noteAppendRequestSchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
});
export type NoteAppendRequest = z.infer<typeof noteAppendRequestSchema>;

export const notePatchRequestSchema = z.object({
  old: z.string().min(1, 'old must not be empty'),
  new: z.string(),
});
export type NotePatchRequest = z.infer<typeof notePatchRequestSchema>;

export const noteRenameRequestSchema = z.object({
  /**
   * リネーム先の vault 相対パス (例: "projects/新名.md"。".md" は省略可 —
   * サーバー側で normalizeVaultPath により補完・検証される)。
   * フォルダをまたぐ移動も可 (Obsidian のノート移動と同義)。
   */
  newPath: z.string().min(1, 'newPath must not be empty'),
});
export type NoteRenameRequest = z.infer<typeof noteRenameRequestSchema>;

export const journalAppendRequestSchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
  date: z.string().optional(),
  /**
   * ATX 見出しテキスト (例: "Todo")。指定時、対象見出し配下の末尾に挿入する。
   * 見出しが存在しなければファイル末尾に見出しごと追記する (insertUnderHeading と同挙動)。
   * 省略時は従来通りファイル末尾に追記する (appendText — 後方互換)。
   * 空文字列は拒否する (min(1))。section="" を省略扱いにするのではなく、スキーマ境界で弾く。
   * [AC-Sd22b1f-3-1]
   */
  section: z.string().min(1).optional(),
});
export type JournalAppendRequest = z.infer<typeof journalAppendRequestSchema>;

// ---- レスポンス ----

export const renameUpdatedNoteSchema = z.object({
  /** リンクを書き換えたノートの vault 相対パス (リネーム後の表記) */
  path: z.string(),
  /** そのノート内で書き換えたリンク数 */
  links: z.number(),
});
export type RenameUpdatedNote = z.infer<typeof renameUpdatedNoteSchema>;

export const noteRenameResponseSchema = z.object({
  /** リネーム前のパス */
  oldPath: z.string(),
  /** リネーム後のパス */
  path: z.string(),
  /** リネーム後ファイルの mtime (ms epoch) */
  mtime: z.number(),
  /** [[リンク]] を書き換えたノートの内訳 (リネームされたノート自身の自己リンクも含む) */
  updatedNotes: z.array(renameUpdatedNoteSchema),
  /** 書き換えたリンク総数 */
  updatedLinks: z.number(),
});
export type NoteRenameResponse = z.infer<typeof noteRenameResponseSchema>;

export const frontmatterSchema = z.record(z.string(), z.unknown()).nullable();

export const noteResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  frontmatter: frontmatterSchema,
  body: z.string(),
  /** ファイルの mtime (ms epoch)。保存時の baseMtime に使う */
  mtime: z.number(),
});
export type NoteResponse = z.infer<typeof noteResponseSchema>;

export const noteWriteResponseSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  /** 書き込み後のファイル mtime (ms epoch)。次回保存の baseMtime に使う */
  mtime: z.number(),
});
export type NoteWriteResponse = z.infer<typeof noteWriteResponseSchema>;

export const noteDeleteResponseSchema = z.object({
  path: z.string(),
  deleted: z.boolean(),
});
export type NoteDeleteResponse = z.infer<typeof noteDeleteResponseSchema>;

export const journalResponseSchema = z.object({
  date: z.string(),
  path: z.string(),
  content: z.string(),
  frontmatter: frontmatterSchema,
  body: z.string(),
  /** このリクエストでファイルが新規生成されたか */
  created: z.boolean(),
  /** ファイルの mtime (ms epoch)。read-only モードの仮想ジャーナル (ファイル無し) は null */
  mtime: z.number().nullable(),
});
export type JournalResponse = z.infer<typeof journalResponseSchema>;

export const journalAppendResponseSchema = z.object({
  date: z.string(),
  path: z.string(),
  /** このリクエストでファイルが新規生成されたか */
  created: z.boolean(),
});
export type JournalAppendResponse = z.infer<typeof journalAppendResponseSchema>;

// ---- インデックス系 (検索・一覧・タグ・バックリンク) ----

export const searchResultSchema = z.object({
  path: z.string(),
  title: z.string(),
  /** Fuse.js スコア (0 = 完全一致に近い)。小さいほど良い */
  score: z.number(),
  /** マッチ箇所を含む行 (スニペット)。本文にマッチが無い場合はタイトル行 */
  snippet: z.string(),
  /** snippet の 1 始まり行番号 (本文マッチ時のみ、それ以外は null) */
  line: z.number().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const noteMetaSchema = z.object({
  path: z.string(),
  title: z.string(),
  /** インライン #tag + frontmatter tags (NFC 正規化、# なし) */
  tags: z.array(z.string()),
  /** vault 相対の親フォルダ ("" = ルート直下) */
  folder: z.string(),
  /**
   * ファイル mtime (ms epoch)。サイドバーの直近 N 件ソート (Sf1a90a-3) に使う。
   * server は常に付与するが、既存 mock との後方互換のため optional。
   */
  mtime: z.number().optional(),
  /**
   * ファイルのバイト数。ファイル/フォルダブラウザ (Seac77a-1) の
   * サイズ表示に使う。server は常に付与するが後方互換のため optional。
   */
  size: z.number().int().nonnegative().optional(),
});
export type NoteMeta = z.infer<typeof noteMetaSchema>;

export const noteListResponseSchema = z.object({
  notes: z.array(noteMetaSchema),
});
export type NoteListResponse = z.infer<typeof noteListResponseSchema>;

export const tagCountSchema = z.object({
  tag: z.string(),
  count: z.number(),
});
export type TagCount = z.infer<typeof tagCountSchema>;

export const tagsResponseSchema = z.object({
  tags: z.array(tagCountSchema),
});
export type TagsResponse = z.infer<typeof tagsResponseSchema>;

export const backlinkLinkSchema = z.object({
  /** リンク元テキスト全体 (例: "[[note#見出し|別名]]") */
  raw: z.string(),
  /** [[note#heading]] の heading 部分 (無ければ null) */
  heading: z.string().nullable(),
  /** リンク元ノート内の 1 始まり行番号 */
  line: z.number(),
  /** リンクを含む行の元テキスト */
  context: z.string(),
});
export type BacklinkLink = z.infer<typeof backlinkLinkSchema>;

export const backlinkSourceSchema = z.object({
  /** リンク元ノートの vault 相対パス */
  source: z.string(),
  links: z.array(backlinkLinkSchema),
});
export type BacklinkSource = z.infer<typeof backlinkSourceSchema>;

export const backlinksResponseSchema = z.object({
  /** 正規化済みターゲットパス */
  path: z.string(),
  backlinks: z.array(backlinkSourceSchema),
});
export type BacklinksResponse = z.infer<typeof backlinksResponseSchema>;

// ---- files (添付ファイル — Sf53ad6) ----

export const fileMetaSchema = z.object({
  /** vault 相対パス (`assets/a.png` 形式、NFC) */
  path: z.string(),
  /** バイト数 */
  size: z.number().int().nonnegative(),
  /** ファイルの mtime (ms epoch) */
  mtime: z.number(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

export const fileListResponseSchema = z.object({
  files: z.array(fileMetaSchema),
});
export type FileListResponse = z.infer<typeof fileListResponseSchema>;

export const fileWriteResponseSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  /** 書き込んだバイト数 */
  size: z.number().int().nonnegative(),
  /** 書き込み後のファイル mtime (ms epoch) */
  mtime: z.number(),
});
export type FileWriteResponse = z.infer<typeof fileWriteResponseSchema>;

export const fileDeleteResponseSchema = z.object({
  path: z.string(),
  deleted: z.boolean(),
});
export type FileDeleteResponse = z.infer<typeof fileDeleteResponseSchema>;

export const fileRenameRequestSchema = z.object({
  /** リネーム先の vault 相対パス (拡張子込み。例: "assets/photo-1.png") */
  newPath: z.string().min(1, 'newPath must not be empty'),
});
export type FileRenameRequest = z.infer<typeof fileRenameRequestSchema>;

export const fileRenameResponseSchema = z.object({
  oldPath: z.string(),
  path: z.string(),
  /** リネーム後ファイルの mtime (ms epoch) */
  mtime: z.number(),
  /** ![[リンク]] を書き換えたノートの内訳 */
  updatedNotes: z.array(renameUpdatedNoteSchema),
  updatedLinks: z.number(),
});
export type FileRenameResponse = z.infer<typeof fileRenameResponseSchema>;

// ---- system/ 設定ファイル一覧 + ソース読み書き (Sa10026-9 #1) ----

/**
 * system/ 配下の 1 ファイルのメタ情報。
 * settings.yaml / smart-folders/*.yaml / templates/*.md / commands/*.yaml を
 * フォルダ構造付きで列挙する (path は "system/…" の vault 相対パス、NFC)。
 */
export const systemFileMetaSchema = z.object({
  /** vault 相対パス (例: "system/smart-folders/recent.yaml"、NFC) */
  path: z.string(),
  /** バイト数 */
  size: z.number().int().nonnegative(),
  /** ファイルの mtime (ms epoch) */
  mtime: z.number(),
});
export type SystemFileMeta = z.infer<typeof systemFileMetaSchema>;

/** GET /api/system-files のレスポンス (path 昇順)。 */
export const systemFileListResponseSchema = z.object({
  files: z.array(systemFileMetaSchema),
});
export type SystemFileListResponse = z.infer<typeof systemFileListResponseSchema>;

/** GET /api/system-files/{path}/source のレスポンス (yaml / md の生テキスト)。 */
export const systemFileSourceResponseSchema = z.object({
  /** vault 相対パス (NFC) */
  path: z.string(),
  /** 生テキスト (pure YAML または pure Markdown) */
  content: z.string(),
  /** ファイル mtime (ms epoch) */
  mtime: z.number(),
});
export type SystemFileSourceResponse = z.infer<typeof systemFileSourceResponseSchema>;

/** PUT /api/system-files/{path}/source のリクエストボディ。 */
export const systemFileSourceWriteRequestSchema = z.object({
  content: z.string(),
  /**
   * 楽観的競合検出。指定時、対象ファイルの現 mtime (ms epoch) と不一致なら 409 conflict。
   * 省略時は無条件で上書き (last-write-wins)。
   */
  mtime: z.number().int().nonnegative().optional(),
});
export type SystemFileSourceWriteRequest = z.infer<typeof systemFileSourceWriteRequestSchema>;

/** PUT /api/system-files/{path}/source のレスポンス。 */
export const systemFileSourceWriteResponseSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  mtime: z.number(),
});
export type SystemFileSourceWriteResponse = z.infer<typeof systemFileSourceWriteResponseSchema>;

/** DELETE /api/system-files/{path}/source のレスポンス。 */
export const systemFileDeleteResponseSchema = z.object({
  path: z.string(),
  deleted: z.boolean(),
});
export type SystemFileDeleteResponse = z.infer<typeof systemFileDeleteResponseSchema>;

// ---- クエリ (dataview 風 DQL — Sb1593c) ----

export const queryRequestSchema = z.object({
  /** DQL クエリ文字列 (例: 'TABLE status from "projects" where status != "done"') */
  query: z.string().min(1, 'query must not be empty'),
});
export type QueryRequest = z.infer<typeof queryRequestSchema>;

export const listQueryRowSchema = z.object({
  path: z.string(),
  title: z.string(),
  /** vault 相対の親フォルダ ("" = ルート直下) */
  folder: z.string(),
});
export type ListQueryRow = z.infer<typeof listQueryRowSchema>;

/** TABLE セル値 (frontmatter 由来。配列は tags 等の文字列配列、欠損は null) */
export const tableCellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);
export type TableCellValue = z.infer<typeof tableCellValueSchema>;

export const tableQueryRowSchema = z.object({
  path: z.string(),
  title: z.string(),
  folder: z.string(),
  /** fields と同順のセル値 */
  values: z.array(tableCellValueSchema),
});
export type TableQueryRow = z.infer<typeof tableQueryRowSchema>;

export const taskQueryRowSchema = z.object({
  path: z.string(),
  title: z.string(),
  /** ノート内の 1 始まり行番号 */
  line: z.number().int().positive(),
  /** チェックボックス以降のテキスト */
  text: z.string(),
  checked: z.boolean(),
  /** 行頭インデント文字数 (ネスト表示用) */
  indent: z.number().int().nonnegative(),
});
export type TaskQueryRow = z.infer<typeof taskQueryRowSchema>;

export const queryResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list'), results: z.array(listQueryRowSchema) }),
  z.object({
    type: z.literal('table'),
    /** TABLE で指定した列フィールド名 (表示順) */
    fields: z.array(z.string()),
    results: z.array(tableQueryRowSchema),
  }),
  z.object({ type: z.literal('task'), results: z.array(taskQueryRowSchema) }),
]);
export type QueryResponse = z.infer<typeof queryResponseSchema>;

/**
 * クエリ構文エラーのレスポンス (400)。{error,message} の互換形に
 * 位置情報 (1 始まり行・列 + トークン長) を additive に足したもの。
 */
export const queryErrorResponseSchema = z.object({
  error: z.literal('query_syntax'),
  /** 位置情報込みの人間可読メッセージ ("N 行 M 列: ...") */
  message: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  length: z.number().int().positive(),
});
export type QueryErrorResponse = z.infer<typeof queryErrorResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// ---- 汎用テンプレート (S89a350) ----

/**
 * テンプレート変数の入力ウィジェット種別。既存 property-types のうち
 * モーダルで扱う 4 種 (text/select/date/tags) に限定する (AC-S89a350-3-1)。
 */
export const templateVarTypeSchema = z.enum(['text', 'select', 'date', 'tags']);
export type TemplateVarType = z.infer<typeof templateVarTypeSchema>;

/** テンプレート定義 1 変数。server が loamium-template.vars を正規化して返す。 */
export const templateVarSchema = z.object({
  /** 変数名 (= `{{name}}` の name、data-var)。 */
  name: z.string(),
  /** 入力ウィジェット種別 (不明な型は server が 'text' にフォールバック)。 */
  type: templateVarTypeSchema,
  /** 必須か (未入力なら instantiate は 4xx)。 */
  required: z.boolean(),
  /** 表示ラベル (省略時は name)。 */
  label: z.string().optional(),
  /** 既定値 (date は `{{date:YYYY-MM-DD}}` 等のテンプレート記法も可)。 */
  default: z.string().optional(),
  /** select の選択肢。 */
  options: z.array(z.string()).optional(),
});
export type TemplateVar = z.infer<typeof templateVarSchema>;

/** GET /api/templates が返すテンプレート 1 件のサマリ。 */
export const templateSummarySchema = z.object({
  /** テンプレート識別子 (templates/ からの相対パス、拡張子なし)。 */
  name: z.string(),
  /** テンプレートファイルの vault 相対パス (templates/xxx.md)。 */
  path: z.string(),
  /** 保存先パターン (loamium-template.target)。無ければ null。 */
  target: z.string().nullable(),
  /** 説明 (loamium-template.description)。 */
  description: z.string().optional(),
  /** 変数定義 (loamium-template.vars を正規化したもの)。 */
  vars: z.array(templateVarSchema),
});
export type TemplateSummary = z.infer<typeof templateSummarySchema>;

export const templatesResponseSchema = z.object({
  templates: z.array(templateSummarySchema),
});
export type TemplatesResponse = z.infer<typeof templatesResponseSchema>;

/**
 * POST /api/templates/{name}/instantiate のリクエスト。
 * vars は変数名→値の文字列マップ。date は {{date:...}} の基準日を上書きする
 * (YYYY-MM-DD、省略時はサーバー今日)。
 */
export const templateInstantiateRequestSchema = z.object({
  vars: z.record(z.string(), z.string()).optional().default({}),
  date: z.string().optional(),
});
export type TemplateInstantiateRequest = z.infer<typeof templateInstantiateRequestSchema>;

export const templateInstantiateResponseSchema = z.object({
  /** 実際に作成されたノートの vault 相対パス (衝突時は連番付き)。 */
  path: z.string(),
  /** 常に true (新規作成)。 */
  created: z.boolean(),
});
export type TemplateInstantiateResponse = z.infer<typeof templateInstantiateResponseSchema>;

/** 不足変数がある場合の 4xx レスポンス (不足変数名の一覧を additive に持つ)。 */
export const templateMissingVarsResponseSchema = z.object({
  error: z.literal('missing_vars'),
  message: z.string(),
  missing: z.array(z.string()),
});
export type TemplateMissingVarsResponse = z.infer<typeof templateMissingVarsResponseSchema>;


export const agentHealthSchema = z.object({
  enabled: z.boolean(),
  reason: z.enum(['not_configured', 'invalid_config']).nullable(),
});
export type AgentHealth = z.infer<typeof agentHealthSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  mode: permissionModeSchema,
  /**
   * エージェント設定の有無 (S53409d-2)。
   * agent.json が有効な場合 enabled:true。
   * 旧バージョンとの後方互換のため optional (未設定時は not_configured 扱い)。
   */
  agent: agentHealthSchema.optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---- エージェント設定 (.loamium/agent.json — S53409d-2) ----

/**
 * Web 検索プロバイダ設定 (ADR-0017 / S5e0206)。web ケーパビリティが有効なとき
 * web_search ツールが叩く検索エンドポイント。マシンローカル。
 *
 * - endpoint: GET で `?q=<query>` を付けて叩く検索 API の URL。
 * - apiKey  : 任意。指定時は `Authorization: Bearer <apiKey>` で送る ($ENV_VAR 参照可)。
 *
 * 未設定 (undefined) は許容 — web が有効でも web_search は「未設定」を明示する
 * (エラーにしない、AC-S5e0206-1-2)。
 */
export const agentWebSearchSchema = z.object({
  endpoint: z.string().min(1, 'webSearch.endpoint must not be empty'),
  apiKey: z.string().min(1).optional(),
});
export type AgentWebSearch = z.infer<typeof agentWebSearchSchema>;

/**
 * エージェントの推論バックエンド選択 (ADR-0025 amendment 2026-07-16)。
 * ユーザーが設定 UI で明示的に選ぶ。自動フォールバックはしない。
 *   - 'external' (既定): 従来どおり外部 API (baseUrl/apiKey/api)。
 *   - 'local'          : 内蔵オフライン LLM (OpenAI 互換 shim 経由)。localModel を使う。
 * 後方互換: 未指定は 'external' 扱い (既存 agent.json をそのまま解釈)。
 */
export const agentBackendSchema = z.enum(['external', 'local']);
export type AgentBackend = z.infer<typeof agentBackendSchema>;

export const agentConfigSchema = z.object({
  api: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().min(1, 'baseUrl must not be empty'),
  model: z.string().min(1, 'model must not be empty'),
  apiKey: z.string().min(1, 'apiKey must not be empty'),
  /**
   * 推論バックエンド選択 (ADR-0025 amendment)。未指定は 'external' (後方互換)。
   */
  backend: agentBackendSchema.optional(),
  /**
   * backend='local' 選択時に使う内蔵モデルのファイル名 (.loamium/models/llm/ 配下)。
   * 未選択 (undefined) なら local バックエンドは「未準備」= 接続無効 (暗黙フォールバックしない)。
   */
  localModel: z.string().min(1).optional(),
  /**
   * エージェント権限 (ADR-0015)。プリセット名 or ケーパビリティ配列。
   * 未指定は read-only プリセット (resolvePermissions が既定を補う)。マシンローカル。
   */
  permissions: agentPermissionsSchema.optional(),
  /**
   * Web 検索プロバイダ設定 (ADR-0017)。web ケーパビリティ有効時に web_search が使う。
   * 未指定は許容 (web_search は未設定を明示メッセージで返す)。
   */
  webSearch: agentWebSearchSchema.optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ---- エージェント機密領域 deny リスト (.loamium/agent-privacy.json — ADR-0018) ----

/**
 * `.loamium/agent-privacy.json` のスキーマ。
 * vault 相対の glob/パス deny リストを定義する。マッチするノートはエージェントの
 * 全ツール (read / search / query / backlinks / tags) から存在ごと隠される。
 *
 * 2 形状を受け付ける (どちらも同義):
 *   - `{ "deny": ["private/**", "secret.md"] }`  … 明示オブジェクト形式 (推奨)
 *   - `["private/**", "secret.md"]`              … 直接 string 配列 (簡易形式)
 * どちらも parse 後は `{ deny: string[] }` に正規化する。
 * 既定 (ファイル不在) は空 = 何も deny しない。
 */
export const agentPrivacySchema = z
  .union([
    z.object({ deny: z.array(z.string()) }),
    z.array(z.string()),
  ])
  .transform((v) => (Array.isArray(v) ? { deny: v } : v));
export type AgentPrivacy = z.infer<typeof agentPrivacySchema>;

// ---- エージェント REST API レスポンス (S53409d-2) ----

/**
 * POST /api/agent/sessions のリクエスト (ADR-0015)。
 * permissions はセッション単位の権限上書き (プリセット名 or ケーパビリティ配列)。
 * body 無し / 空オブジェクトも許容 (未指定なら agent.json 既定にフォールバック)。
 */
export const agentCreateSessionRequestSchema = z.object({
  permissions: agentPermissionsSchema.optional(),
});
export type AgentCreateSessionRequest = z.infer<typeof agentCreateSessionRequestSchema>;

export const agentSessionCreateResponseSchema = z.object({
  id: z.string(),
});
export type AgentSessionCreateResponse = z.infer<typeof agentSessionCreateResponseSchema>;

export const agentSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  updatedAt: z.number(),
});
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

export const agentSessionListResponseSchema = z.object({
  sessions: z.array(agentSessionSummarySchema),
});
export type AgentSessionListResponse = z.infer<typeof agentSessionListResponseSchema>;

export const agentToolSummarySchema = z.object({
  name: z.string(),
  argsSummary: z.string(),
  status: z.enum(['running', 'done']),
});
export type AgentToolSummary = z.infer<typeof agentToolSummarySchema>;

export const agentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  tools: z.array(agentToolSummarySchema),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentSessionDetailResponseSchema = z.object({
  id: z.string(),
  messages: z.array(agentMessageSchema),
  /**
   * 実効ケーパビリティ配列 (ADR-0015)。セッション権限 (or agent.json 既定) を
   * サーバー LOAMIUM_MODE でクランプした結果。UI の権限表示に使う。
   * 後方互換のため optional (旧クライアント/旧レスポンスとの互換)。
   */
  effectivePermissions: z.array(z.enum(AGENT_CAPABILITIES)).optional(),
});
export type AgentSessionDetailResponse = z.infer<typeof agentSessionDetailResponseSchema>;

export const agentSendMessageRequestSchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
});
export type AgentSendMessageRequest = z.infer<typeof agentSendMessageRequestSchema>;

/**
 * PUT /api/agent/sessions/{id}/permissions のレスポンス (セッション中の権限変更)。
 * 要求した permissions を LOAMIUM_MODE でクランプした実効ケーパビリティ配列を返す。
 */
export const agentSessionPermissionsResponseSchema = z.object({
  effectivePermissions: z.array(z.enum(AGENT_CAPABILITIES)),
});
export type AgentSessionPermissionsResponse = z.infer<
  typeof agentSessionPermissionsResponseSchema
>;

export const agentAbortResponseSchema = z.object({
  ok: z.boolean(),
});
export type AgentAbortResponse = z.infer<typeof agentAbortResponseSchema>;

// ---- 意味型スキーマ配信 (GET /api/property-types — S87f4b7-2) ----

/**
 * GET /api/property-types のレスポンス。`.loamium/property-types.json` の生 JSON を
 * そのまま `types` に載せる (無ければ {})。中身の妥当性検証はクライアント側
 * (parsePropertyTypesJson) に委ね、壊れた JSON でもクラッシュしないため types は
 * z.unknown (緩い) にする — サーバーはユーザーの JSON を拒否しない (AC-S87f4b7-2-3)。
 */
export const propertyTypesResponseSchema = z.object({
  types: z.unknown(),
});
export type PropertyTypesResponse = z.infer<typeof propertyTypesResponseSchema>;

// ---- vault 横断プロパティキー集約 (GET /api/property-keys — Sd13ab1-2) ----

/**
 * GET /api/property-keys のレスポンス。全ノートの frontmatter トップレベルキーを
 * 件数付きで集約する (既存 GET /api/tags と同型)。件数降順→キー昇順。
 * キーファースト追加メニュー zone ① の vault 実使用キー候補に使う。
 */
export const propertyKeysResponseSchema = z.object({
  keys: z.array(z.object({ key: z.string(), count: z.number().int().nonnegative() })),
});
export type PropertyKeysResponse = z.infer<typeof propertyKeysResponseSchema>;

// ---- 型永続化 (PUT /api/property-types — Sd13ab1-2, D方式の横断固定) ----

/**
 * 新規プロパティ作成時に選んだ汎用型を `.loamium/property-types.json` へ永続化する
 * リクエスト。以後そのキーは全ファイルで同じ型に解決される (D方式の横断固定)。
 * options は select/multi-select の選択肢 (string | {value,color})。
 * 型情報は .loamium/ にのみ書き、ノート本文 (.md) には一切書かない (ピュア Markdown)。
 */
export const propertyTypeWriteRequestSchema = z.object({
  key: z.string().min(1),
  def: z.object({
    type: z.enum([
      'text',
      'number',
      'date',
      'checkbox',
      'select',
      'multi-select',
      'tags',
      'star',
      'progress',
      'url',
      'note-link',
    ]),
    options: z
      .array(
        z.union([
          z.string(),
          z.object({
            value: z.string(),
            color: z.enum(['green', 'blue', 'amber', 'purple', 'red', 'gray']).optional(),
          }),
        ]),
      )
      .optional(),
  }),
});
export type PropertyTypeWriteRequest = z.infer<typeof propertyTypeWriteRequestSchema>;

/** PUT /api/property-types のレスポンス。書き込んだキーと結果の型定義全体を返す。 */
export const propertyTypeWriteResponseSchema = z.object({
  key: z.string(),
  types: z.unknown(),
});
export type PropertyTypeWriteResponse = z.infer<typeof propertyTypeWriteResponseSchema>;


// ---- スマートフォルダ定義 (ADR-0002 / ADR-0003 — S32940c-2) ----

/**
 * pin.path がノートパス (.md) またはフォルダパス (no .md) として有効かを検証する。
 * ADR-0005: pin はノートまたは物理フォルダを対象にできる (後方互換)。
 * - ノートパス ("note.md" や ".md" 拡張子付き): isValidVaultPath で検証 (NFC・traversal 拒否)
 * - フォルダパス ("projects" や "projects/sub"): normalizeVaultFilePath で検証 (traversal・隠しセグメント拒否)
 * どちらの形式も `..`・絶対パス・隠しセグメントは拒否する。
 */
function isValidPinPath(input: string): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  // normalizeVaultFilePath はノートパス (.md 付き) もフォルダパスも受け入れる
  // (traversal / hidden / absolute を拒否する点は normalizeVaultPath と同一)
  try {
    normalizeVaultFilePath(input);
    return true;
  } catch (err) {
    if (err instanceof VaultPathError) return false;
    return false;
  }
}

/**
 * スマートフォルダ要素 — kind='pin': 単一ノートの葉、またはフォルダの配下ノート一覧。
 * pin.path はノートパス (.md) またはフォルダパス (no .md) を指せる (ADR-0005)。
 * パスは normalizeVaultFilePath で検証済みのファイルシステム安全な vault 相対パス。
 * (ADR-0003: pin / query の 2 種のみ — ADR-0005 で pin の対象をフォルダまで拡張)
 */
export const smartViewPinItemSchema = z.object({
  kind: z.literal('pin'),
  id: z.string().min(1, 'id must not be empty'),
  name: z.string().optional(),
  icon: z.string().optional(),
  path: z
    .string()
    .min(1, 'pin.path must not be empty')
    .refine(isValidPinPath, {
      message:
        'pin.path is not a valid vault path (path traversal, hidden segments, or empty not allowed)',
    }),
});
export type SmartViewPinItem = z.infer<typeof smartViewPinItemSchema>;

/**
 * スマートフォルダ要素 — kind='query': DQL 結果の名前付きフォルダ。
 * query.dql は parseQuery で構文検証済みの DQL 文字列 (ADR-0001)。
 */
export const smartViewQueryItemSchema = z.object({
  kind: z.literal('query'),
  id: z.string().min(1, 'id must not be empty'),
  name: z.string().min(1, 'query.name must not be empty'),
  icon: z.string().optional(),
  dql: z
    .string()
    .min(1, 'query.dql must not be empty')
    .refine(
      (dql) => {
        try {
          parseQuery(dql);
          return true;
        } catch (err) {
          if (err instanceof DqlParseError) return false;
          return false;
        }
      },
      { message: 'query.dql is not valid DQL syntax' },
    ),
});
export type SmartViewQueryItem = z.infer<typeof smartViewQueryItemSchema>;

/**
 * スマートフォルダ要素 (discriminated union on kind)。
 * ADR-0003: pin | query の 2 種のみ (pins / 混在なし)。
 */
export const smartViewItemSchema = z.discriminatedUnion('kind', [
  smartViewPinItemSchema,
  smartViewQueryItemSchema,
]);
export type SmartViewItem = z.infer<typeof smartViewItemSchema>;

/**
 * スマートフォルダ定義一式 (.loamium/smart-folders.json)。
 * version: スキーマ版 (初版 = 1)、items: 表示順の SmartViewItem 配列。
 * ADR-0002: git 追跡対象 (ユーザー設定の正本)。
 */
export const smartViewConfigSchema = z.object({
  version: z.number().int().min(1, 'version must be a positive integer'),
  items: z.array(smartViewItemSchema),
});
export type SmartViewConfig = z.infer<typeof smartViewConfigSchema>;

/**
 * GET /api/smart-folders/{id}/notes のレスポンス。
 * query → executeQuery、pin → 当該 1 件 (存在しなければ空配列)。
 */
export const smartFoldersResolveResponseSchema = z.object({
  notes: z.array(noteMetaSchema),
});
export type SmartFoldersResolveResponse = z.infer<typeof smartFoldersResolveResponseSchema>;

// ---- フロントマタープロパティ書込 (POST /api/notes/{path}/properties — S32940c-3) ----

/**
 * スカラー値のみ許可 (string | number | boolean | null)。
 * ネスト・配列・オブジェクトは拒否 (frontmatter の安全な round-trip が保証できないため)。
 */
const propScalarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const notePropertyWriteRequestSchema = z.object({
  /** 追加・更新するキー→スカラー値マップ (upsert セマンティクス) */
  set: z.record(z.string(), propScalarValueSchema).optional(),
  /** 削除するキー名の配列 */
  unset: z.array(z.string()).optional(),
});
export type NotePropertyWriteRequest = z.infer<typeof notePropertyWriteRequestSchema>;

export const notePropertyWriteResponseSchema = z.object({
  path: z.string(),
  /** 書き込み後の frontmatter (キー→値)。frontmatter なし = null */
  frontmatter: frontmatterSchema,
  /** 書き込み後のファイル mtime (ms epoch) */
  mtime: z.number(),
});
export type NotePropertyWriteResponse = z.infer<typeof notePropertyWriteResponseSchema>;

// ---- ノートメタ集約 (GET /api/notes/{path}/meta — S11493d-1) ----

export const noteHeadingSchema = z.object({
  /** 見出しレベル (1–6) */
  level: z.number().int().min(1).max(6),
  /** 見出しテキスト (先頭 # と空白を除いたもの) */
  text: z.string(),
  /** ノート全体における 1 始まりの行番号 */
  line: z.number().int().positive(),
});
export type NoteHeading = z.infer<typeof noteHeadingSchema>;

export const outgoingLinkSchema = z.object({
  /** リンクターゲット (NFC 正規化済み。heading / alias を除く) */
  target: z.string(),
  /**
   * target を vault 内パスに解決した結果。解決できなければ null (壊れたリンク)。
   */
  resolvedPath: z.string().nullable(),
  /** リンク元テキスト全体 (例: "[[note#heading|別名]]") */
  raw: z.string(),
});
export type OutgoingLink = z.infer<typeof outgoingLinkSchema>;

/**
 * GET /api/notes/{path}/meta のレスポンス。
 * ノート 1 件のメタ情報を ONE リクエストで返す (AC-S11493d-1-1)。
 */
export const noteMetaResponseSchema = z.object({
  /** vault 相対パス (NFC 正規化) */
  path: z.string(),
  /** ATX 見出し一覧 (frontmatter・code-fence 除外、出現順) */
  headings: z.array(noteHeadingSchema),
  /** アウトゴーイングリンク一覧 (ターゲットで重複除去、出現順) */
  outgoingLinks: z.array(outgoingLinkSchema),
  /** インライン #tag + frontmatter tags (NFC 正規化・# なし・重複除去) */
  tags: z.array(z.string()),
  /** パース済み frontmatter (無ければ null) */
  frontmatter: frontmatterSchema,
  /** ファイルの mtime (ms epoch) */
  mtime: z.number(),
  /**
   * ワード数 (frontmatter・code-fence 除外。CJK 文字は 1 文字 = 1 ワード)。
   */
  wordCount: z.number().int().nonnegative(),
  /** 文字数 (frontmatter・code-fence 除外。スペース・改行を含む Unicode コードポイント数) */
  charCount: z.number().int().nonnegative(),
});
export type NoteMetaResponse = z.infer<typeof noteMetaResponseSchema>;

// ---- 監査ログ (JSONL 1 行分) ----

export const auditEntrySchema = z.object({
  ts: z.string(),
  op: z.string(),
  path: z.string(),
  mode: permissionModeSchema,
  result: z.enum(['ok', 'denied', 'error']),
  status: z.number(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

// ---- スマートコマンド一覧 (GET /api/commands — Sd22b1f-1) ----

/**
 * GET /api/commands が返すコマンド 1 件のサマリ。
 * valid:false の場合も一覧に含め、error フィールドで原因を示す (寛容 read)。
 */
export const commandSummarySchema = z.discriminatedUnion('valid', [
  z.object({
    /**
     * 安定識別子 = ファイルの stem (拡張子なし)。例: "create-todo"。
     * POST /api/commands/{id}/run の {id} として使う。表示名 (name) とは異なる場合がある。
     */
    id: z.string(),
    /** 表示名 (loamium-command.name、省略時は stem と同値)。パレット表示に使う。 */
    name: z.string(),
    /** コマンドファイルの vault 相対パス (commands/xxx.md)。 */
    path: z.string(),
    /** 人間向け説明 (loamium-command.description)。 */
    description: z.string().optional(),
    /** パラメータ定義 (loamium-command.params)。 */
    params: z.array(commandParamSchema),
    /** 常に true (正常定義)。 */
    valid: z.literal(true),
  }),
  z.object({
    /**
     * 安定識別子 = ファイルの stem (拡張子なし)。frontmatter が壊れていてもファイル名から導出。
     */
    id: z.string(),
    /** ファイル名 (拡張子なし)。frontmatter が壊れているためファイル名から導出。 */
    name: z.string(),
    /** コマンドファイルの vault 相対パス。 */
    path: z.string(),
    /** 常に false (無効定義)。 */
    valid: z.literal(false),
    /** 壊れた原因の人間可読メッセージ。 */
    error: z.string(),
  }),
]);
export type CommandSummary = z.infer<typeof commandSummarySchema>;

export const commandsResponseSchema = z.object({
  commands: z.array(commandSummarySchema),
});
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;

// ---- スマートコマンド実行 (POST /api/commands/{name}/run — Sd22b1f-2) ----

/**
 * POST /api/commands/{name}/run のリクエストボディ。
 * params: コマンドパラメータの名前→値マップ。
 */
export const commandRunRequestSchema = z.object({
  params: z.record(z.string(), z.string()).optional().default({}),
});
export type CommandRunRequest = z.infer<typeof commandRunRequestSchema>;

/**
 * ステップ 1 件の実行結果。
 * - ok: true / skipped: true → 条件付きスキップ (ADR-0022)。副作用なし・失敗ではない。
 * - ok: true / skipped 未定義 → 正常実行
 * - ok: false → 失敗 (error に失敗理由)
 */
export const commandStepResultSchema = z.object({
  /** ステップ kind (journal-append / note-append / note-create / template-instantiate) */
  kind: z.string(),
  /** 成功 = true / 失敗 = false */
  ok: z.boolean(),
  /** 書き込んだ vault 相対パス (成功かつ path が確定したステップのみ) */
  path: z.string().optional(),
  /** 失敗理由 (ok:false のみ) */
  error: z.string().optional(),
  /**
   * ADR-0022: when / when-not 条件によりスキップされたステップは skipped:true を返す。
   * ok:true かつ skipped:true → 副作用なし・次ステップ続行。
   * スキップはエラーではない (fail-stop を引き起こさない)。
   */
  skipped: z.boolean().optional(),
});
export type CommandStepResult = z.infer<typeof commandStepResultSchema>;

/**
 * POST /api/commands/{name}/run のレスポンス。
 * - results: ステップごとの実行結果 (実行したぶんのみ、最初の失敗で停止)
 * - openPath: open:true が指定されたステップが書き込んだパス (UI 遷移用)
 */
export const commandRunResponseSchema = z.object({
  results: z.array(commandStepResultSchema),
  openPath: z.string().optional(),
});
export type CommandRunResponse = z.infer<typeof commandRunResponseSchema>;

// ---- スマートコマンド定義ソース読み書き (GET/PUT /api/commands/{id}/source) ----

/**
 * GET /api/commands/{id}/source のレスポンス。
 * .yaml / .yml ファイルの生テキストを返す (notes API の .md 強制を回避)。
 */
export const commandSourceResponseSchema = z.object({
  /** コマンド識別子 (stem、拡張子なし)。例: "create-todo" */
  id: z.string(),
  /** vault 相対パス。例: "commands/create-todo.yaml" */
  path: z.string(),
  /** ファイルの生テキスト (pure YAML) */
  content: z.string(),
  /** ファイルの mtime (ms epoch)。楽観的競合検出に使う */
  mtime: z.number(),
});
export type CommandSourceResponse = z.infer<typeof commandSourceResponseSchema>;

/**
 * PUT /api/commands/{id}/source のリクエストボディ。
 * content: 書き込む生テキスト (pure YAML)。
 * mtime: 楽観的競合検出 (省略時は無条件上書き)。
 */
export const commandSourceWriteRequestSchema = z.object({
  content: z.string(),
  /**
   * 楽観的競合検出。指定時、対象ファイルの現 mtime (ms epoch) と不一致なら 409 conflict。
   * 省略時は無条件で上書き (last-write-wins)。
   */
  mtime: z.number().int().nonnegative().optional(),
});
export type CommandSourceWriteRequest = z.infer<typeof commandSourceWriteRequestSchema>;

/**
 * PUT /api/commands/{id}/source のレスポンス。
 */
export const commandSourceWriteResponseSchema = z.object({
  /** コマンド識別子 (stem) */
  id: z.string(),
  /** 書き込んだ vault 相対パス */
  path: z.string(),
  /** 新規作成か */
  created: z.boolean(),
  /** 書き込み後の mtime (ms epoch) */
  mtime: z.number(),
});
export type CommandSourceWriteResponse = z.infer<typeof commandSourceWriteResponseSchema>;

// ============================================================
// 設定 API (Sa10026-5)
// ============================================================

// ---- Group 1: アプリ全体設定 (system/settings.yaml) ----

/**
 * アプリ全体設定スキーマ (`appSettingsSchema`) と `AppSettings` 型は
 * system-definitions.ts (Sa10026-3) が正本として定義する
 * (theme/defaultFolder/journalTemplate/showSystemFolder を既定値付き + passthrough)。
 * ここでは response/write wrapper のためにそれを import して参照する。
 */

/** GET /api/settings/system のレスポンス。 */
export const appSettingsResponseSchema = z.object({
  settings: appSettingsSchema,
});
export type AppSettingsResponse = z.infer<typeof appSettingsResponseSchema>;

/** PUT /api/settings/system のリクエスト。 */
export const appSettingsWriteRequestSchema = z.object({
  settings: appSettingsSchema,
});
export type AppSettingsWriteRequest = z.infer<typeof appSettingsWriteRequestSchema>;

// ---- Group 2: agent 接続設定 (.loamium/agent.json) ----

/**
 * GET /api/settings/agent/connection のレスポンス。
 * apiKey は $ENV_VAR 参照名をそのまま返す (実値は返さない)。
 * 未設定 (agent.json 不在) は null を返す。
 */
export const agentConnectionResponseSchema = z.object({
  connection: z
    .object({
      api: z.enum(['openai', 'anthropic']),
      baseUrl: z.string(),
      model: z.string(),
      /** $ENV_VAR 参照名、または "(set)" / "(unset)" — 実値は絶対に返さない */
      apiKeyRef: z.string(),
      /**
       * API キーが設定済みかを示す boolean (UI が「保存済み」プレースホルダを出すために使う)。
       * apiKeyRef が "$ENV_VAR" のときも true。実値は含まない。
       */
      hasApiKey: z.boolean().optional(),
      /**
       * 推論バックエンド選択 (S8a3f2e-4 / ADR-0025 amendment)。未指定 (旧 agent.json) は 'external' 扱い。
       * UI はこの値でバックエンドセグメントの初期選択を決める。
       */
      backend: agentBackendSchema.optional(),
      /**
       * backend='local' 選択時に使う内蔵モデルのファイル名 (.loamium/models/llm/ 配下)。
       * 未選択 (undefined) なら local バックエンドは未準備 = 接続無効 (自動フォールバックしない)。
       */
      localModel: z.string().optional(),
      webSearch: z
        .object({
          endpoint: z.string(),
          /** $ENV_VAR 参照名、または "(set)" / "(unset)" */
          apiKeyRef: z.string().optional(),
        })
        .optional(),
    })
    .nullable(),
});
export type AgentConnectionResponse = z.infer<typeof agentConnectionResponseSchema>;

/**
 * PUT /api/settings/agent/connection のリクエスト。
 * apiKey は直値 (sk-... 等) または "$ENV_VAR" 形式の参照名を保存する。
 * apiKey を省略した場合、サーバーは既存の apiKey を維持する (上書きしない)。
 * これにより UI が「保存済み」プレースホルダを表示している状態で保存しても
 * キーが "(set)" で上書きされることを防ぐ。
 */
export const agentConnectionWriteRequestSchema = z.object({
  api: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().min(1, 'baseUrl must not be empty'),
  model: z.string().min(1, 'model must not be empty'),
  /**
   * 直値 (sk-xxx 等) または "$ENV_VAR" 形式の参照名。
   * 省略時はサーバーが既存の apiKey をそのまま維持する。
   */
  apiKey: z.string().min(1, 'apiKey must not be empty').optional(),
  /**
   * 推論バックエンド選択 (S8a3f2e-4)。省略時はサーバーが既存の backend を維持する。
   * 'local' を保存してもモデル未選択 (localModel なし) なら接続は無効 (自動フォールバックしない)。
   */
  backend: agentBackendSchema.optional(),
  /**
   * backend='local' 時に使うローカルモデルのファイル名 (.loamium/models/llm/ 配下)。
   *   - string : そのモデルを選択して保存。
   *   - null   : 選択を明示的にクリア (local 未選択 = 接続無効)。
   *   - 省略   : 既存の localModel をそのまま維持する。
   */
  localModel: z.string().min(1).nullable().optional(),
  webSearch: z
    .object({
      endpoint: z.string().min(1, 'webSearch.endpoint must not be empty'),
      apiKey: z.string().min(1).optional(),
    })
    .optional(),
});
export type AgentConnectionWriteRequest = z.infer<typeof agentConnectionWriteRequestSchema>;

/** PUT /api/settings/agent/connection のレスポンス。 */
export const agentConnectionWriteResponseSchema = z.object({
  ok: z.boolean(),
});
export type AgentConnectionWriteResponse = z.infer<typeof agentConnectionWriteResponseSchema>;

// ---- Group 3: agent 権限・capability (.loamium/agent.json permissions) ----

/**
 * GET /api/settings/agent/permissions のレスポンス。
 * 未設定 (agent.json 不在) は null。
 */
export const agentPermissionsResponseSchema = z.object({
  permissions: z
    .object({
      /** agent.json の permissions フィールド (プリセット名 or ケーパビリティ配列) */
      value: z.union([z.string(), z.array(z.string())]).nullable(),
      /** LOAMIUM_MODE でクランプした実効ケーパビリティ */
      effective: z.array(z.string()),
    })
    .nullable(),
});
export type AgentPermissionsResponse = z.infer<typeof agentPermissionsResponseSchema>;

/**
 * PUT /api/settings/agent/permissions のリクエスト。
 * agent.json の permissions フィールドのみ更新する (接続設定は変更しない)。
 */
export const agentPermissionsWriteRequestSchema = z.object({
  /** プリセット名 (read-only / notes-rw / full) またはケーパビリティ配列 */
  permissions: z.union([z.string(), z.array(z.string())]),
});
export type AgentPermissionsWriteRequest = z.infer<typeof agentPermissionsWriteRequestSchema>;

/** PUT /api/settings/agent/permissions のレスポンス。 */
export const agentPermissionsWriteResponseSchema = z.object({
  ok: z.boolean(),
});
export type AgentPermissionsWriteResponse = z.infer<typeof agentPermissionsWriteResponseSchema>;

// ---- Group 4: privacy deny-list (.loamium/agent-privacy.json) ----

/**
 * GET /api/settings/agent/privacy のレスポンス。
 * ファイル不在時は空配列。
 */
export const agentPrivacySettingsResponseSchema = z.object({
  deny: z.array(z.string()),
});
export type AgentPrivacySettingsResponse = z.infer<typeof agentPrivacySettingsResponseSchema>;

/** PUT /api/settings/agent/privacy のリクエスト。 */
export const agentPrivacyWriteRequestSchema = z.object({
  deny: z.array(z.string()),
});
export type AgentPrivacyWriteRequest = z.infer<typeof agentPrivacyWriteRequestSchema>;

/** PUT /api/settings/agent/privacy のレスポンス。 */
export const agentPrivacyWriteResponseSchema = z.object({
  ok: z.boolean(),
});
export type AgentPrivacyWriteResponse = z.infer<typeof agentPrivacyWriteResponseSchema>;

// ---- 接続テスト (POST /api/settings/agent/connection/test) ----

/** POST /api/settings/agent/connection/test のリクエスト。 */
export const agentConnectionTestRequestSchema = z.object({
  /** テスト対象の baseUrl (省略時は現在の agent.json の値を使う) */
  baseUrl: z.string().min(1).optional(),
  /**
   * テスト対象のモデル (省略可。接続テストは model 不要の /models エンドポイントで実施する)。
   * @deprecated model は接続テストに不要になった。互換性のため残すが無視される。
   */
  model: z.string().min(1).optional(),
  /** api 種別 (省略時は現在の agent.json の値を使う) */
  api: z.enum(['openai', 'anthropic']).optional(),
  /** $ENV_VAR 参照名または直値 (省略時は現在の agent.json の値を使う) */
  apiKeyRef: z.string().optional(),
});
export type AgentConnectionTestRequest = z.infer<typeof agentConnectionTestRequestSchema>;

/** POST /api/settings/agent/connection/test のレスポンス (常に 200)。 */
export const agentConnectionTestResponseSchema = z.object({
  ok: z.boolean(),
  /**
   * 接続テスト成功時に取得したモデル一覧。UI はこれを使ってドロップダウンを populate する。
   * テスト失敗時は undefined (または空配列)。
   */
  models: z.array(z.string()).optional(),
  /** リクエストから応答までのミリ秒 */
  latencyMs: z.number().optional(),
  /** エラーメッセージ (失敗時のみ。apiKey 実値は含まない) */
  error: z.string().optional(),
});
export type AgentConnectionTestResponse = z.infer<typeof agentConnectionTestResponseSchema>;

// ---- モデル一覧 (GET /api/settings/agent/models) ----

/**
 * GET /api/settings/agent/models のレスポンス (常に 200)。
 * 取得成功時 source:'api'、失敗時 source:'fallback' (空リストで直接入力を妨げない)。
 */
export const agentModelsResponseSchema = z.object({
  models: z.array(z.string()),
  source: z.enum(['api', 'fallback']),
  error: z.string().optional(),
});
export type AgentModelsResponse = z.infer<typeof agentModelsResponseSchema>;

// ---- 内蔵ローカル LLM: OpenAI 互換 shim (S8a3f2e-2 / ADR-0025) ----

/**
 * OpenAI /v1/chat/completions リクエストの最小サブセット (AC-S8a3f2e-2-1)。
 * shim は pi SDK (openai-completions アダプタ) からのリクエストを受ける。
 * 受け付けるのは {model, messages[], stream, max_tokens, temperature} のみ。
 * 未知フィールドは passthrough で許容する (OpenAI クライアントは追加フィールドを送るため)。
 */
/**
 * OpenAI content パート (text)。pi SDK (openai-completions) は content を文字列で
 * なく `[{type:'text', text}]` の配列で送ることがある。text 以外のパート
 * (image_url 等) はローカル LLM では扱わないため type/text 以外は passthrough で
 * 受けつつ shim 側でテキストのみ拾う (messagesToPrompt)。
 */
export const llmChatContentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();
export type LlmChatContentPart = z.infer<typeof llmChatContentPartSchema>;

/**
 * content は文字列 or content パート配列のどちらも受ける (OpenAI 互換)。
 * pi / OpenAI クライアントの両表現をそのまま受理し、縮約は shim が担う。
 */
export const llmChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(llmChatContentPartSchema)]),
});
export type LlmChatMessage = z.infer<typeof llmChatMessageSchema>;

export const llmChatRequestSchema = z
  .object({
    model: z.string().min(1, 'model must not be empty'),
    messages: z.array(llmChatMessageSchema).min(1, 'messages must not be empty'),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).optional(),
  })
  .passthrough();
export type LlmChatRequest = z.infer<typeof llmChatRequestSchema>;

// ---- 内蔵ローカル LLM: モデル管理 REST (S8a3f2e-3 / ADR-0025) ----

/**
 * GET /api/llm/models の 1 エントリ (AC-S8a3f2e-3-1)。
 * path は vault 相対 (.loamium/models/llm/<filename>)。
 */
export const localModelInfoSchema = z.object({
  id: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
  path: z.string(),
});
export type LocalModelInfo = z.infer<typeof localModelInfoSchema>;

export const localModelListResponseSchema = z.object({
  models: z.array(localModelInfoSchema),
});
export type LocalModelListResponse = z.infer<typeof localModelListResponseSchema>;

/**
 * POST /api/llm/models/download のリクエスト (AC-S8a3f2e-3-2)。
 * filename は省略可 (URL 末尾から導出)。保存先は必ず .loamium/models/llm/ 内に封じ込める。
 */
export const localModelDownloadRequestSchema = z.object({
  url: z.string().url('url must be a valid URL'),
  filename: z.string().min(1).optional(),
});
export type LocalModelDownloadRequest = z.infer<typeof localModelDownloadRequestSchema>;

/** ダウンロードジョブの状態 (AC-S8a3f2e-3-2: 完了・失敗を判別できる)。 */
export const localModelDownloadStatusSchema = z.enum([
  'pending',
  'downloading',
  'completed',
  'failed',
]);
export type LocalModelDownloadStatus = z.infer<typeof localModelDownloadStatusSchema>;

/** POST /api/llm/models/download のレスポンス (ジョブ受理)。ポーリング用 id を返す。 */
export const localModelDownloadAcceptedResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  status: localModelDownloadStatusSchema,
});
export type LocalModelDownloadAcceptedResponse = z.infer<
  typeof localModelDownloadAcceptedResponseSchema
>;

/** GET /api/llm/models/download/:id/status のレスポンス (進捗ポーリング)。 */
export const localModelDownloadStatusResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  status: localModelDownloadStatusSchema,
  /** 受信済みバイト数。 */
  receivedBytes: z.number(),
  /** Content-Length から得た総バイト数 (不明なら null)。 */
  totalBytes: z.number().nullable(),
  /** 失敗時のエラーメッセージ (それ以外は undefined)。 */
  error: z.string().optional(),
});
export type LocalModelDownloadStatusResponse = z.infer<
  typeof localModelDownloadStatusResponseSchema
>;

/** DELETE /api/llm/models/:filename のレスポンス。 */
export const localModelDeleteResponseSchema = z.object({
  ok: z.literal(true),
  filename: z.string(),
});
export type LocalModelDeleteResponse = z.infer<typeof localModelDeleteResponseSchema>;
