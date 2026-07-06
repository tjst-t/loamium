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
  noteRenameResponseSchema,
  noteResponseSchema,
  noteWriteResponseSchema,
  errorResponseSchema,
  parsePropertyTypesJson,
  propertyTypesResponseSchema,
  queryErrorResponseSchema,
  queryResponseSchema,
  searchResponseSchema,
  tagsResponseSchema,
  type PropertyTypeDef,
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
  type NoteRenameResponse,
  type NoteResponse,
  type NoteWriteResponse,
  type QueryResponse,
  type SearchResponse,
} from '@loamium/shared';

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

export const api = {
  /** 機能フラグ検出 (Sb7f458-2 — ターミナルの有効/無効と理由)。 */
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

  listNotes(): Promise<NoteListResponse> {
    return request(noteListResponseSchema, '/api/notes');
  },

  getNote(path: string): Promise<NoteResponse> {
    return request(noteResponseSchema, `/api/notes/${encodeNotePath(path)}`);
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
};
