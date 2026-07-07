/**
 * notes エンドポイント群。
 *
 * - GET    /api/notes/{path}          ノート取得 (content + frontmatter)
 * - PUT    /api/notes/{path}          作成・上書き
 * - DELETE /api/notes/{path}          削除
 * - POST   /api/notes/{path}/append   末尾追記
 * - POST   /api/notes/{path}/patch    old→new 部分置換 (old 不在 / 曖昧は 409)
 * - POST   /api/notes/{path}/rename   リネーム + vault 全体の [[旧名]] 追従書き換え
 */
import { Hono } from 'hono';
import {
  appendText,
  countOccurrences,
  noteAppendRequestSchema,
  notePropertyWriteRequestSchema,
  notePatchRequestSchema,
  noteRenameRequestSchema,
  noteWriteRequestSchema,
  normalizeVaultPath,
  parseNote,
  parsePropertiesModel,
  serializeFrontmatterBlock,
  preferredLinkTarget,
  resolveLinkTarget,
  rewriteLinks,
  VaultPathError,
  type NoteDeleteResponse,
  type NotePropertyWriteResponse,
  type NoteRenameResponse,
  type NoteResponse,
  type NoteWriteResponse,
  type PropEntry,
  type RenameUpdatedNote,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { deleteNote, listNoteFiles, noteMtime, readNote, writeNote } from '../vault.js';
import type { VaultIndex } from '../noteIndex.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';

const NOTES_PREFIX = '/api/notes/';
const POST_ACTIONS = ['append', 'patch', 'rename', 'properties'] as const;
type PostAction = (typeof POST_ACTIONS)[number];

/** リクエストパスから vault 相対のノートパスを取り出して正規化する。 */
function notePathFrom(rawPath: string, stripAction: PostAction | null = null): string {
  let rest = rawPath.slice(NOTES_PREFIX.length);
  if (stripAction !== null) {
    const suffix = `/${stripAction}`;
    if (!rest.endsWith(suffix)) {
      // 例: POST /api/notes/append (ノートパスが空) — アクションだけでパスが無い
      throw new VaultPathError(`note path is missing before /${stripAction}`);
    }
    rest = rest.slice(0, rest.length - suffix.length);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new VaultPathError('path is not valid percent-encoding');
  }
  return normalizeVaultPath(decoded);
}

export function notesRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
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
    const mtime = await noteMtime(config.vaultRoot, rel);
    if (content === null || mtime === null) {
      return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
    }
    const parsed = parseNote(content);
    const res: NoteResponse = {
      path: rel,
      content: parsed.content,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      mtime,
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
    if (body.data.baseMtime !== undefined) {
      // 楽観的競合検出: 読み込み時点の mtime と現在の mtime が食い違ったら
      // 上書きせず 409 を返す (データ安全性 priority 2 — 迷ったらファイルを守る)。
      // ファイルが消えている場合は非破壊 (再作成) なのでそのまま書く。
      const current = await noteMtime(config.vaultRoot, rel);
      if (current !== null && current !== body.data.baseMtime) {
        return errorJson(
          c,
          409,
          'conflict',
          `note was modified by another process (mtime ${current} != baseMtime ${body.data.baseMtime})`,
        );
      }
    }
    const { created, mtime } = await writeNote(config.vaultRoot, rel, body.data.content);
    const res: NoteWriteResponse = { path: rel, created, mtime };
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
        'POST /api/notes/{path}/(append|patch|rename|properties) のみサポートしています',
      );
    }
    let rel: string;
    try {
      rel = notePathFrom(rawPath, action);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }

    if (action === 'rename') {
      // リネーム + vault 全体のリンク追従 (SPEC §9 高-2 / AC-S6fbf45-3-1)。
      // データ安全性 (priority 2): 書き込みは全計算が終わってから。移動先が
      // 既存なら 409 で拒否し、解決先が旧パスであるリンクだけを書き換える。
      setAudit(c, 'note.rename', rel);
      const body = await parseBody(c, noteRenameRequestSchema);
      if (!body.ok) return body.response;
      let newRel: string;
      try {
        newRel = normalizeVaultPath(body.data.newPath);
      } catch (err) {
        if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
        throw err;
      }
      const oldContent = await readNote(config.vaultRoot, rel);
      if (oldContent === null) {
        return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
      }
      if (newRel === rel) {
        // 同名リネームは no-op (冪等)
        const mtime = await noteMtime(config.vaultRoot, rel);
        const res: NoteRenameResponse = {
          oldPath: rel,
          path: rel,
          mtime: mtime ?? 0,
          updatedNotes: [],
          updatedLinks: 0,
        };
        return c.json(res);
      }
      if ((await noteMtime(config.vaultRoot, newRel)) !== null) {
        return errorJson(c, 409, 'conflict', `rename target already exists: ${newRel}`);
      }

      // ---- Phase 1: 読み取りと書き換え計算のみ (この間ディスクへの書き込みゼロ) ----
      // インデックスではなくファイルシステムを走査する (priority 6: ファイルが正)。
      const pathSet = new Set(await listNoteFiles(config.vaultRoot));
      pathSet.add(rel);
      const before = [...pathSet];
      const after = before.map((p) => (p === rel ? newRel : p));
      // 書き換え後リンクは新パスに必ず解決する最短表記 (basename 衝突時はフルパス)
      const replacement = preferredLinkTarget(newRel, after);
      // 解決先が旧パスのリンクだけ書き換える。同名 basename が別ノートに解決される
      // 曖昧リンクは対象外 (勝手に付け替えない — priority 2)。
      const shouldRewrite = (target: string): string | null =>
        resolveLinkTarget(target, before) === rel ? replacement : null;

      let movedContent = oldContent;
      let selfLinks = 0;
      const sourceUpdates: { path: string; content: string; links: number }[] = [];
      for (const p of before) {
        const content = p === rel ? oldContent : await readNote(config.vaultRoot, p);
        if (content === null) continue; // 走査後に消えたファイルは対象外
        const rewritten = rewriteLinks(content, shouldRewrite);
        if (p === rel) {
          movedContent = rewritten.content; // 自己リンクも追従
          selfLinks = rewritten.count;
        } else if (rewritten.count > 0) {
          sourceUpdates.push({ path: p, content: rewritten.content, links: rewritten.count });
        }
      }

      // ---- Phase 2: 適用 (移動 → 参照元書き換え) ----
      const updatedNotes: RenameUpdatedNote[] = [];
      let written: { created: boolean; mtime: number };
      try {
        written = await writeNote(config.vaultRoot, newRel, movedContent);
        await deleteNote(config.vaultRoot, rel);
        if (selfLinks > 0) updatedNotes.push({ path: newRel, links: selfLinks });
        for (const u of sourceUpdates) {
          await writeNote(config.vaultRoot, u.path, u.content);
          updatedNotes.push({ path: u.path, links: u.links });
        }
      } catch (err) {
        // 部分適用の隠蔽はしない: どこまで適用されたかを明示して 500 を返す
        // (vault は Git 管理前提 — VISION。ユーザーが差分を確認して復旧できる)
        const appliedList = updatedNotes.map((u) => u.path).join(', ') || '(none)';
        return errorJson(
          c,
          500,
          'rename_partial_failure',
          `rename was interrupted mid-apply (rewritten so far: ${appliedList}); ` +
            `the vault is git-managed — review \`git diff\` to recover. cause: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }

      // ---- インデックス即時追従 (audit ミドルウェアの単一パス更新では足りない) ----
      index.removeFile(rel);
      try {
        await index.refreshFile(newRel);
        for (const u of sourceUpdates) await index.refreshFile(u.path);
      } catch (err) {
        // ファイルは正しく書けている。インデックスは chokidar / 再起動で自己修復する
        console.error(`[loamium] index refresh after rename failed:`, err);
      }

      const res: NoteRenameResponse = {
        oldPath: rel,
        path: newRel,
        mtime: written.mtime,
        updatedNotes,
        updatedLinks: updatedNotes.reduce((sum, u) => sum + u.links, 0),
      };
      return c.json(res);
    }

    if (action === 'properties') {
      // フロントマタープロパティ書込 (ADR-0004 / S32940c-3)。
      // データ安全性 (priority 2): parsePropertiesModel が null (= 安全にモデル化できない) なら
      // 4xx を返してファイルを一切変更しない。round-trip 検証も必ず実施する。
      setAudit(c, 'note.property.write', rel);
      const reqBody = await parseBody(c, notePropertyWriteRequestSchema);
      if (!reqBody.ok) return reqBody.response;

      const existing = await readNote(config.vaultRoot, rel);
      if (existing === null) {
        return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
      }

      // frontmatter と body を分離する。
      // afterFrontmatter = closing --- 行の直後から末尾まで (先頭の \n を含む)。
      const FRONTMATTER_OPEN = /^---(?:\r?\n)/;
      const parsed = parseNote(existing);

      let entries: PropEntry[];
      let afterFrontmatter: string;

      if (!FRONTMATTER_OPEN.test(existing)) {
        // frontmatter ブロックが存在しない → 空のモデルで開始し新規作成する
        entries = [];
        afterFrontmatter = existing.length > 0 ? '\n' + existing : '';
      } else if (parsed.frontmatter === null) {
        // --- 構文はあるが YAML が壊れている / トップレベルがオブジェクトでない
        return errorJson(
          c,
          422,
          'unprocessable_frontmatter',
          'note has frontmatter that cannot be safely parsed (broken YAML or non-object); edit it manually',
        );
      } else {
        // 有効な frontmatter — YAML テキストを再抽出してモデルへ分解する
        const lines = existing.split('\n');
        let closeIndex = -1;
        for (let i = 1; i < lines.length; i++) {
          if ((lines[i] ?? '').replace(/\r$/, '') === '---') {
            closeIndex = i;
            break;
          }
        }
        // frontmatter !== null が保証する closing --- が必ず存在する
        const yamlText = lines
          .slice(1, closeIndex)
          .map((l) => l.replace(/\r$/, ''))
          .join('\n');
        const model = parsePropertiesModel(yamlText);
        if (model === null) {
          // アンカー・マージキー・重複キー等で安全にモデル化できない
          return errorJson(
            c,
            422,
            'unprocessable_frontmatter',
            'note frontmatter is too complex to safely modify (anchors, merge keys, duplicate keys, or similar); edit it manually',
          );
        }
        entries = model;
        const bodyLines = lines.slice(closeIndex + 1);
        afterFrontmatter = bodyLines.length > 0 ? '\n' + bodyLines.join('\n') : '';
      }

      // --- set / unset 適用 ---
      const { set: setMap, unset: unsetKeys } = reqBody.data;

      // unset: 指定キーのエントリを削除 (raw = コメント・空行は保持)
      if (unsetKeys !== undefined && unsetKeys.length > 0) {
        entries = entries.filter(
          (e): boolean => e.kind === 'raw' || !unsetKeys.includes(e.key),
        );
      }

      // set: キーが既存なら上書き、無ければ末尾に追加 (upsert)
      if (setMap !== undefined) {
        for (const [key, value] of Object.entries(setMap)) {
          const existingIdx = entries.findIndex((e) => e.kind !== 'raw' && e.key === key);
          if (existingIdx >= 0) {
            // source を持つ既存エントリを上書き (source 削除で再直列化させる)
            entries[existingIdx] = { kind: 'scalar', key, value };
          } else {
            entries.push({ kind: 'scalar', key, value });
          }
        }
      }

      // --- 直列化 ---
      const block = serializeFrontmatterBlock(entries);
      // block === null → 全キーが除去された → frontmatter ブロックごと削除
      let newContent: string;
      if (block === null) {
        // afterFrontmatter は '\n' + body 形式。先頭の \n を剥がして body だけにする
        newContent = afterFrontmatter.length > 0 ? afterFrontmatter.slice(1) : '';
      } else {
        newContent = block + afterFrontmatter;
      }

      // --- round-trip 安全性の最終検証 (priority 2) ---
      const roundTripped = parseNote(newContent);
      if (block !== null && roundTripped.frontmatter === null) {
        // 直列化結果が再パースできない → 書かずに拒否
        return errorJson(
          c,
          422,
          'roundtrip_failed',
          'serialized frontmatter could not be re-parsed; refusing to write (data safety priority 2)',
        );
      }

      const written = await writeNote(config.vaultRoot, rel, newContent);
      const res: NotePropertyWriteResponse = {
        path: rel,
        frontmatter: roundTripped.frontmatter,
        mtime: written.mtime,
      };
      return c.json(res);
    }

    if (action === 'append') {
      setAudit(c, 'note.append', rel);
      const body = await parseBody(c, noteAppendRequestSchema);
      if (!body.ok) return body.response;
      const existing = await readNote(config.vaultRoot, rel);
      if (existing === null) {
        return errorJson(c, 404, 'not_found', `note not found: ${rel}`);
      }
      const appended = await writeNote(config.vaultRoot, rel, appendText(existing, body.data.content));
      const res: NoteWriteResponse = { path: rel, created: false, mtime: appended.mtime };
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
    // 関数形式で置換: new に $& / $' 等が含まれても特殊解釈させない (データ安全性)
    const updated = existing.replace(body.data.old, () => body.data.new);
    const patched = await writeNote(config.vaultRoot, rel, updated);
    const res: NoteWriteResponse = { path: rel, created: false, mtime: patched.mtime };
    return c.json(res);
  });

  return app;
}
