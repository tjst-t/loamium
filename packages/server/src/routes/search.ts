/**
 * インデックス系エンドポイント群 (すべて読み取り専用 — 全権限モードで許可)。
 *
 * - GET /api/search?q=          全文検索 (パス + マッチ箇所スニペット)
 * - GET /api/notes?tag=&folder= ノート一覧 (タグ / フォルダで絞り込み)
 * - GET /api/tags               タグ一覧 (件数付き)
 * - GET /api/backlinks?path=    対象ノートへのバックリンク一覧
 * - POST /api/query             DQL 簡易サブセット (LIST / TABLE / TASK — Sb1593c-1)。
 *   POST だがファイルを一切書かない純読み取り (permissions で read 分類)。
 *   構文エラーは 400 {error:'query_syntax', message, line, column, length}
 */
import { Hono } from 'hono';
import {
  DqlParseError,
  normalizeVaultPath,
  parseQuery,
  executeQuery,
  queryRequestSchema,
  VaultPathError,
  type BacklinksResponse,
  type NoteListResponse,
  type PropertyKeysResponse,
  type QueryErrorResponse,
  type QueryResponse,
  type SearchResponse,
  type TagsResponse,
} from '@loamium/shared';
import { errorJson, parseBody, type AppEnv } from '../http.js';
import type { VaultIndex } from '../noteIndex.js';

export function searchRoutes(index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (q === undefined || q.trim().length === 0) {
      return errorJson(c, 400, 'missing_query', 'query parameter "q" is required');
    }
    const res: SearchResponse = { query: q, results: index.search(q) };
    return c.json(res);
  });

  app.get('/api/notes', (c) => {
    const tag = c.req.query('tag');
    const folder = c.req.query('folder');
    const filter: { tag?: string; folder?: string } = {};
    if (tag !== undefined) filter.tag = tag;
    if (folder !== undefined) filter.folder = folder;
    const res: NoteListResponse = { notes: index.listNotes(filter) };
    return c.json(res);
  });

  app.get('/api/tags', (c) => {
    const res: TagsResponse = { tags: index.tags() };
    return c.json(res);
  });

  // 全ノートの frontmatter トップレベルキーを件数付き集約 (Sd13ab1-2)。
  // 読み取り専用 (全権限モードで許可)。chokidar 追従はインデックス側で担保。
  app.get('/api/property-keys', (c) => {
    const res: PropertyKeysResponse = { keys: index.propertyKeys() };
    return c.json(res);
  });

  app.post('/api/query', async (c) => {
    const body = await parseBody(c, queryRequestSchema);
    if (!body.ok) return body.response;
    let res: QueryResponse;
    try {
      res = executeQuery(parseQuery(body.data.query), index.queryNotes());
    } catch (err) {
      if (err instanceof DqlParseError) {
        // {error,message} 互換形 + 位置情報 (additive — AC-Sb1593c-1-1)
        const errorBody: QueryErrorResponse = {
          error: 'query_syntax',
          message: err.message,
          line: err.line,
          column: err.column,
          length: err.length,
        };
        return c.json(errorBody, 400);
      }
      throw err;
    }
    return c.json(res);
  });

  app.get('/api/backlinks', (c) => {
    const raw = c.req.query('path');
    if (raw === undefined || raw.length === 0) {
      return errorJson(c, 400, 'missing_path', 'query parameter "path" is required');
    }
    let rel: string;
    try {
      rel = normalizeVaultPath(raw);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    const res: BacklinksResponse = { path: rel, backlinks: index.backlinks(rel) };
    return c.json(res);
  });

  return app;
}
