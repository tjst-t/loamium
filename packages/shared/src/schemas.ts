/**
 * REST API のリクエスト/レスポンス zod スキーマ。
 * server と (将来の) cli / ui で共有する (DESIGN_PRINCIPLES coding_conventions)。
 */
import { z } from 'zod';
import { normalizeVaultFilePath, VaultPathError } from './path.js';
import { parseQuery, DqlParseError } from './dql.js';
import { commandParamSchema } from './loamium-command.js';

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
   * [AC-Sd22b1f-3-1]
   */
  section: z.string().optional(),
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

/**
 * ターミナル (WS /api/terminal) が無効な理由の機械可読コード (Sb7f458)。
 * - terminal_env_not_set: LOAMIUM_TERMINAL=1 が未設定 (デフォルト無効 — SPEC §6)
 * - mode_not_full:        LOAMIUM_MODE が full ではない (read-only / append-only)
 */
export const terminalDisabledReasonSchema = z.enum(['terminal_env_not_set', 'mode_not_full']);
export type TerminalDisabledReason = z.infer<typeof terminalDisabledReasonSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  mode: permissionModeSchema,
  /** ターミナル機能フラグ (Sb7f458-2 — UI が無効理由の表示に使う)。additive 拡張 */
  terminal: z.object({
    enabled: z.boolean(),
    reason: terminalDisabledReasonSchema.nullable(),
    /** 有効時のみ: pty で起動するコマンド (タブ表示用) */
    cmd: z.string().optional(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

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

// ---- ターミナル WS メッセージ (Sb7f458-1) ----

/** クライアント → サーバー: キー入力 or 端末リサイズ */
export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

/** サーバー → クライアント: pty 出力 or 子プロセス終了通知 */
export const terminalServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number() }),
]);
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;

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
    /** コマンド識別名 (loamium-command.name、省略時はファイル名拡張子なし)。 */
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
 * - ok: true の場合は成功 (path は書き込んだパス)
 * - ok: false の場合は失敗 (error に失敗理由)
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
