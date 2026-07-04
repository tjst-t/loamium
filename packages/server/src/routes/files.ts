/**
 * files エンドポイント (S9e5ca4-2 配信 + Sf53ad6 アップロード/一覧/削除/リネーム)。
 *
 * - GET    /api/files              添付 (非 .md) ファイル一覧 (path/size/mtime)
 * - GET    /api/files/{path}       vault 内ファイルの読み取り専用配信 (画像・添付等)
 * - POST   /api/files/{path}       raw body アップロード (既存は ?overwrite=true なしで 409)
 * - DELETE /api/files/{path}       添付ファイル削除
 * - POST   /api/files/{path}/rename 添付リネーム + vault 全体の ![[旧名]] 追従書き換え
 *
 * GET は読み取りなので全権限モードで許可。POST/DELETE は mutate に分類され
 * read-only / append-only で 403 になる (permissions.ts の既定分類)。
 *
 * パス検証は shared の normalizeVaultFilePath を経由 (CLAUDE.md):
 * - traversal / 絶対パス等の不正パス → 400 invalid_path
 * - 隠しセグメント: GET は 404 (存在自体を隠す)、書き込み系は 400 invalid_path
 *   (拒否理由を機械可読に返す — 書き込み拒否では存在を隠す意味がない)
 * - `.md` への書き込み系は 400 use_notes_api (notes API へ誘導 — AC-Sf53ad6-1-2)
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  fileRenameRequestSchema,
  HiddenVaultPathError,
  normalizeVaultFilePath,
  preferredFileLinkTarget,
  resolveFileLinkTarget,
  rewriteLinks,
  VaultPathError,
  type FileDeleteResponse,
  type FileListResponse,
  type FileRenameResponse,
  type FileWriteResponse,
  type RenameUpdatedNote,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import {
  deleteVaultFile,
  isVaultDirectory,
  listNoteFiles,
  listVaultFiles,
  moveVaultFile,
  readNote,
  readVaultFile,
  statVaultFile,
  writeNote,
  writeVaultFile,
} from '../vault.js';
import type { VaultIndex } from '../noteIndex.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';

const FILES_PREFIX = '/api/files/';

/**
 * 拡張子 → Content-Type の最小マップ。
 * 未知の拡張子は application/octet-stream (ブラウザに実行させない安全側)。
 * .html を text/html で返すと vault 内の任意 HTML が同一オリジンで実行される
 * ため、テキスト系は text/plain に倒す (DESIGN_PRINCIPLES priority 2)。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  htm: 'text/plain; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function contentTypeOf(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

type PathResult = { ok: true; rel: string } | { ok: false; response: Response };

/**
 * リクエストパスから vault 相対の添付パスを取り出して正規化する。
 * 書き込み系は隠しセグメントも 400 invalid_path、.md は use_notes_api に写像する。
 */
function filePathFrom(
  c: Context<AppEnv>,
  opts: { write: boolean; stripAction?: string },
): PathResult {
  let rest = c.req.path.slice(FILES_PREFIX.length);
  if (opts.stripAction !== undefined) {
    const suffix = `/${opts.stripAction}`;
    if (!rest.endsWith(suffix)) {
      return {
        ok: false,
        response: errorJson(c, 400, 'invalid_path', `file path is missing before ${suffix}`),
      };
    }
    rest = rest.slice(0, rest.length - suffix.length);
  }
  let rel: string;
  try {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      throw new VaultPathError('path is not valid percent-encoding');
    }
    rel = normalizeVaultFilePath(decoded);
  } catch (err) {
    if (err instanceof HiddenVaultPathError && !opts.write) {
      // 隠し領域は存在自体を隠す (audit.log 等の内容漏えい防止)
      return { ok: false, response: errorJson(c, 404, 'not_found', 'file not found') };
    }
    if (err instanceof VaultPathError) {
      return { ok: false, response: errorJson(c, 400, 'invalid_path', err.message) };
    }
    throw err;
  }
  if (opts.write && rel.toLowerCase().endsWith('.md')) {
    return {
      ok: false,
      response: errorJson(
        c,
        400,
        'use_notes_api',
        `.md files are managed by the notes API — use PUT/DELETE /api/notes/{path} instead of /api/files (path: ${rel})`,
      ),
    };
  }
  return { ok: true, rel };
}

export function filesRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- 一覧 (非 .md の添付ファイル) — UI ツリー・衝突チェック用 ----
  app.get('/api/files', async (c) => {
    const res: FileListResponse = { files: await listVaultFiles(config.vaultRoot) };
    return c.json(res);
  });

  // ---- 読み取り専用配信 (S9e5ca4-2) ----
  app.get(`${FILES_PREFIX}*`, async (c) => {
    const parsed = filePathFrom(c, { write: false });
    if (!parsed.ok) return parsed.response;
    const rel = parsed.rel;
    const buf = await readVaultFile(config.vaultRoot, rel);
    if (buf === null) {
      return errorJson(c, 404, 'not_found', `file not found: ${rel}`);
    }
    return c.body(new Uint8Array(buf), 200, {
      'content-type': contentTypeOf(rel),
      'x-content-type-options': 'nosniff',
    });
  });

  // ---- アップロード + リネーム (Sf53ad6) ----
  app.post(`${FILES_PREFIX}*`, async (c) => {
    if (c.req.path.endsWith('/rename')) return renameHandler(c);
    return uploadHandler(c);
  });

  async function uploadHandler(c: Context<AppEnv>): Promise<Response> {
    const parsed = filePathFrom(c, { write: true });
    if (!parsed.ok) return parsed.response;
    const rel = parsed.rel;
    setAudit(c, 'file.write', rel);

    // サイズ上限 (AC-Sf53ad6-1-2): Content-Length で先に弾き、実バイト数でも検証する
    const limit = config.maxUploadBytes;
    const declared = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limit) {
      return errorJson(
        c,
        413,
        'too_large',
        `upload exceeds the size limit: ${String(declared)} bytes > ${String(limit)} bytes (LOAMIUM_MAX_UPLOAD)`,
      );
    }
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.byteLength > limit) {
      return errorJson(
        c,
        413,
        'too_large',
        `upload exceeds the size limit: ${String(body.byteLength)} bytes > ${String(limit)} bytes (LOAMIUM_MAX_UPLOAD)`,
      );
    }

    // 既存パス保護 (AC-Sf53ad6-1-1): overwrite フラグなしの上書きは 409
    if (await isVaultDirectory(config.vaultRoot, rel)) {
      return errorJson(c, 409, 'conflict', `path is a directory: ${rel}`);
    }
    const existing = await statVaultFile(config.vaultRoot, rel);
    const overwrite = c.req.query('overwrite') === 'true';
    if (existing !== null && !overwrite) {
      return errorJson(
        c,
        409,
        'conflict',
        `file already exists: ${rel} (pass ?overwrite=true to replace it)`,
      );
    }

    let written: { created: boolean; size: number; mtime: number };
    try {
      written = await writeVaultFile(config.vaultRoot, rel, body);
    } catch (err) {
      // 親セグメントが既存ファイル (assets/a.png/b.png 等) は mkdir が
      // EEXIST (親がファイル) / ENOTDIR (さらに深い階層) で落ちる
      if (
        err instanceof Error &&
        'code' in err &&
        (err.code === 'ENOTDIR' || err.code === 'EEXIST')
      ) {
        return errorJson(c, 409, 'conflict', `a parent segment is an existing file: ${rel}`);
      }
      throw err;
    }
    const res: FileWriteResponse = { path: rel, ...written };
    return c.json(res, written.created ? 201 : 200);
  }

  async function renameHandler(c: Context<AppEnv>): Promise<Response> {
    // 添付リネーム + vault 全体の ![[旧名]] 追従 (AC-Sf53ad6-2-3)。
    // notes rename (S6fbf45) と同じ compute-then-apply: 書き込みは全計算後。
    const parsed = filePathFrom(c, { write: true, stripAction: 'rename' });
    if (!parsed.ok) return parsed.response;
    const rel = parsed.rel;
    setAudit(c, 'file.rename', rel);
    const body = await parseBody(c, fileRenameRequestSchema);
    if (!body.ok) return body.response;
    let newRel: string;
    try {
      newRel = normalizeVaultFilePath(body.data.newPath);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }
    if (newRel.toLowerCase().endsWith('.md')) {
      return errorJson(
        c,
        400,
        'use_notes_api',
        `attachments cannot be renamed to .md — notes are managed by /api/notes (newPath: ${newRel})`,
      );
    }
    const source = await statVaultFile(config.vaultRoot, rel);
    if (source === null) {
      return errorJson(c, 404, 'not_found', `file not found: ${rel}`);
    }
    if (newRel === rel) {
      const res: FileRenameResponse = {
        oldPath: rel,
        path: rel,
        mtime: source.mtime,
        updatedNotes: [],
        updatedLinks: 0,
      };
      return c.json(res); // 同名リネームは no-op (冪等)
    }
    if ((await statVaultFile(config.vaultRoot, newRel)) !== null) {
      return errorJson(c, 409, 'conflict', `rename target already exists: ${newRel}`);
    }

    // ---- Phase 1: 読み取りと書き換え計算のみ (ディスク書き込みゼロ) ----
    const fileSet = new Set((await listVaultFiles(config.vaultRoot)).map((f) => f.path));
    fileSet.add(rel);
    const before = [...fileSet];
    const after = before.map((p) => (p === rel ? newRel : p));
    const replacement = preferredFileLinkTarget(newRel, after);
    // 解決先が旧パスのリンクだけ書き換える (曖昧リンクは触らない — priority 2)
    const shouldRewrite = (target: string): string | null =>
      resolveFileLinkTarget(target, before) === rel ? replacement : null;

    const sourceUpdates: { path: string; content: string; links: number }[] = [];
    for (const notePath of await listNoteFiles(config.vaultRoot)) {
      const content = await readNote(config.vaultRoot, notePath);
      if (content === null) continue; // 走査後に消えたノートは対象外
      const rewritten = rewriteLinks(content, shouldRewrite);
      if (rewritten.count > 0) {
        sourceUpdates.push({ path: notePath, content: rewritten.content, links: rewritten.count });
      }
    }

    // ---- Phase 2: 適用 (ファイル移動 → 参照元書き換え) ----
    const updatedNotes: RenameUpdatedNote[] = [];
    try {
      await moveVaultFile(config.vaultRoot, rel, newRel);
      for (const u of sourceUpdates) {
        await writeNote(config.vaultRoot, u.path, u.content);
        updatedNotes.push({ path: u.path, links: u.links });
      }
    } catch (err) {
      // 部分適用の隠蔽はしない (notes rename と同じ規約 — vault は Git 管理前提)
      const appliedList = updatedNotes.map((u) => u.path).join(', ') || '(none)';
      return errorJson(
        c,
        500,
        'rename_partial_failure',
        `file rename was interrupted mid-apply (rewritten so far: ${appliedList}); ` +
          `the vault is git-managed — review \`git diff\` to recover. cause: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }

    // ---- インデックス即時追従 (リンク書き換えを検索・バックリンクへ反映) ----
    try {
      for (const u of sourceUpdates) await index.refreshFile(u.path);
    } catch (err) {
      // ファイルは正しく書けている。インデックスは chokidar / 再起動で自己修復する
      console.error(`[loamium] index refresh after file rename failed:`, err);
    }

    const moved = await statVaultFile(config.vaultRoot, newRel);
    const res: FileRenameResponse = {
      oldPath: rel,
      path: newRel,
      mtime: moved?.mtime ?? source.mtime,
      updatedNotes,
      updatedLinks: updatedNotes.reduce((sum, u) => sum + u.links, 0),
    };
    return c.json(res);
  }

  // ---- 削除 (Sf53ad6-2: ツリーの添付削除) ----
  app.delete(`${FILES_PREFIX}*`, async (c) => {
    const parsed = filePathFrom(c, { write: true });
    if (!parsed.ok) return parsed.response;
    const rel = parsed.rel;
    setAudit(c, 'file.delete', rel);
    const deleted = await deleteVaultFile(config.vaultRoot, rel);
    if (!deleted) {
      return errorJson(c, 404, 'not_found', `file not found: ${rel}`);
    }
    const res: FileDeleteResponse = { path: rel, deleted: true };
    return c.json(res);
  });

  return app;
}
