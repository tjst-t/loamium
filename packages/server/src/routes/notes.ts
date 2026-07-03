/**
 * notes エンドポイント群。
 *
 * - GET    /api/notes/{path}          ノート取得 (content + frontmatter)
 * - PUT    /api/notes/{path}          作成・上書き
 * - DELETE /api/notes/{path}          削除
 * - POST   /api/notes/{path}/append   末尾追記
 * - POST   /api/notes/{path}/patch    old→new 部分置換 (old 不在 / 曖昧は 409)
 */
import { Hono } from 'hono';
import {
  appendText,
  countOccurrences,
  noteAppendRequestSchema,
  notePatchRequestSchema,
  noteWriteRequestSchema,
  normalizeVaultPath,
  parseNote,
  VaultPathError,
  type NoteDeleteResponse,
  type NoteResponse,
  type NoteWriteResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { deleteNote, readNote, writeNote } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';

const NOTES_PREFIX = '/api/notes/';
const POST_ACTIONS = ['append', 'patch'] as const;
type PostAction = (typeof POST_ACTIONS)[number];

/** リクエストパスから vault 相対のノートパスを取り出して正規化する。 */
function notePathFrom(rawPath: string, stripAction: PostAction | null = null): string {
  let rest = rawPath.slice(NOTES_PREFIX.length);
  if (stripAction !== null) {
    rest = rest.slice(0, rest.length - (stripAction.length + 1));
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new VaultPathError('path is not valid percent-encoding');
  }
  return normalizeVaultPath(decoded);
}

export function notesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(`${NOTES_PREFIX}*`, async (c) => {
    let rel: string;
    try {
      rel = notePathFrom(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    const content = await readNote(config.vaultRoot, rel);
    if (content === null) {
      return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
    }
    const parsed = parseNote(content);
    const res: NoteResponse = {
      path: rel,
      content: parsed.content,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
    return c.json(res);
  });

  app.put(`${NOTES_PREFIX}*`, async (c) => {
    let rel: string;
    try {
      rel = notePathFrom(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    setAudit(c, 'note.write', rel);
    const body = await parseBody(c, noteWriteRequestSchema);
    if (!body.ok) return body.response;
    const { created } = await writeNote(config.vaultRoot, rel, body.data.content);
    const res: NoteWriteResponse = { path: rel, created };
    return c.json(res, created ? 201 : 200);
  });

  app.delete(`${NOTES_PREFIX}*`, async (c) => {
    let rel: string;
    try {
      rel = notePathFrom(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    setAudit(c, 'note.delete', rel);
    const deleted = await deleteNote(config.vaultRoot, rel);
    if (!deleted) {
      return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
    }
    const res: NoteDeleteResponse = { path: rel, deleted: true };
    return c.json(res);
  });

  app.post(`${NOTES_PREFIX}*`, async (c) => {
    const rawPath = c.req.path;
    const action = POST_ACTIONS.find((a) => rawPath.endsWith(`/${a}`));
    if (!action) {
      return errorJson(
        c,
        404,
        'unknown_action',
        'POST /api/notes/{path}/(append|patch) のみサポートしています',
      );
    }
    let rel: string;
    try {
      rel = notePathFrom(rawPath, action);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }

    if (action === 'append') {
      setAudit(c, 'note.append', rel);
      const body = await parseBody(c, noteAppendRequestSchema);
      if (!body.ok) return body.response;
      const existing = await readNote(config.vaultRoot, rel);
      if (existing === null) {
        return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
      }
      await writeNote(config.vaultRoot, rel, appendText(existing, body.data.content));
      const res: NoteWriteResponse = { path: rel, created: false };
      return c.json(res);
    }

    // patch
    setAudit(c, 'note.patch', rel);
    const body = await parseBody(c, notePatchRequestSchema);
    if (!body.ok) return body.response;
    const existing = await readNote(config.vaultRoot, rel);
    if (existing === null) {
      return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
    }
    const count = countOccurrences(existing, body.data.old);
    if (count === 0) {
      return errorJson(c, 409, 'old_not_found', 'old string not found in note');
    }
    if (count > 1) {
      // データ安全性 (priority 2): 曖昧な置換は実行しない
      return errorJson(
        c,
        409,
        'ambiguous_match',
        `old string matches ${count} locations; provide a more specific old string`,
      );
    }
    const updated = existing.replace(body.data.old, body.data.new);
    await writeNote(config.vaultRoot, rel, updated);
    const res: NoteWriteResponse = { path: rel, created: false };
    return c.json(res);
  });

  return app;
}
