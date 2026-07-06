/**
 * REST API のリクエスト/レスポンス zod スキーマ。
 * server と (将来の) cli / ui で共有する (DESIGN_PRINCIPLES coding_conventions)。
 */
import { z } from 'zod';

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
