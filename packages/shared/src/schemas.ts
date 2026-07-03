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

export const journalAppendRequestSchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
  date: z.string().optional(),
});
export type JournalAppendRequest = z.infer<typeof journalAppendRequestSchema>;

// ---- レスポンス ----

export const frontmatterSchema = z.record(z.string(), z.unknown()).nullable();

export const noteResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  frontmatter: frontmatterSchema,
  body: z.string(),
});
export type NoteResponse = z.infer<typeof noteResponseSchema>;

export const noteWriteResponseSchema = z.object({
  path: z.string(),
  created: z.boolean(),
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
});
export type JournalResponse = z.infer<typeof journalResponseSchema>;

export const journalAppendResponseSchema = z.object({
  date: z.string(),
  path: z.string(),
  /** このリクエストでファイルが新規生成されたか */
  created: z.boolean(),
});
export type JournalAppendResponse = z.infer<typeof journalAppendResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  mode: permissionModeSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

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
