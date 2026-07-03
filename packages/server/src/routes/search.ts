/**
 * インデックス系エンドポイント群 (すべて読み取り専用 — 全権限モードで許可)。
 *
 * - GET /api/search?q=          全文検索 (パス + マッチ箇所スニペット)
 * - GET /api/notes?tag=&folder= ノート一覧 (タグ / フォルダで絞り込み)
 * - GET /api/tags               タグ一覧 (件数付き)
 * - GET /api/backlinks?path=    対象ノートへのバックリンク一覧
 */
import { Hono } from 'hono';
import {
  normalizeVaultPath,
  VaultPathError,
  type BacklinksResponse,
  type NoteListResponse,
  type SearchResponse,
  type TagsResponse,
} from '@loamium/shared';
import { errorJson, type AppEnv } from '../http.js';
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
