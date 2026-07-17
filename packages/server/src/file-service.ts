/**
 * 添付ファイル (非 .md) 書き込みサービス層 (ADR-0016)。
 *
 * REST ルート (files.ts) とエージェント書き込みツール (agent-file-tools.ts) の
 * **両方**が呼ぶ単一のサービス層。
 *
 * ADR-0016 契約: エージェント専用の書き込み実装を新設しない。file 書き込み
 * (作成/上書き)・リネーム/移動 (![[リンク]] 追従)・削除のロジックをここへ集約し、
 * REST もエージェントも同じコードを通す (二重管理の排除)。低レベル file 操作
 * (vault.ts) は無加工バイト列で書く (添付は正本のバイナリ — 改行変換しない)。
 *
 * 戻り値は throw ではなく**判別可能な結果型**にする。ルート (HTTP ステータス) と
 * ツール (テキスト結果) の両方が同じセマンティクス (conflict / too_large / not_found /
 * partial_failure) を分岐で扱えるようにするため。I/O 障害はそのまま伝播させる。
 */
import {
  preferredFileLinkTarget,
  resolveFileLinkTarget,
  rewriteLinks,
  type RenameUpdatedNote,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import {
  deleteVaultFile,
  isVaultDirectory,
  listNoteFiles,
  listVaultFiles,
  moveVaultFile,
  readNote,
  statVaultFile,
  writeNote,
  writeVaultFile,
} from './vault.js';

// ---- 添付書き込み (作成/上書き) ----------------------------------------------

/**
 * 添付ファイル書き込み結果 (作成/上書き)。
 * - too_large   : サイズ上限超過 (LOAMIUM_MAX_UPLOAD)。
 * - conflict    : overwrite なしの既存 / 親セグメントが既存ファイル / ディレクトリ。
 */
export type FileWriteResult =
  | { ok: true; created: boolean; size: number; mtime: number }
  | { ok: false; reason: 'too_large'; message: string }
  | { ok: false; reason: 'conflict'; message: string };

/**
 * 添付ファイル (非 .md) を作成 or 上書きする (POST /api/files/{path} と同一のコア)。
 * data はバイト列 (無加工で書く)。overwrite なしで既存があれば conflict。
 * サイズ上限超過は too_large。
 */
export async function writeAttachment(
  config: ServerConfig,
  rel: string,
  data: Buffer,
  overwrite: boolean,
): Promise<FileWriteResult> {
  const limit = config.maxUploadBytes;
  if (data.byteLength > limit) {
    return {
      ok: false,
      reason: 'too_large',
      message: `data exceeds the size limit: ${String(data.byteLength)} bytes > ${String(limit)} bytes (LOAMIUM_MAX_UPLOAD)`,
    };
  }
  if (await isVaultDirectory(config.vaultRoot, rel)) {
    return { ok: false, reason: 'conflict', message: `path is a directory: ${rel}` };
  }
  const existing = await statVaultFile(config.vaultRoot, rel);
  if (existing !== null && !overwrite) {
    return {
      ok: false,
      reason: 'conflict',
      message: `file already exists: ${rel} (pass overwrite:true to replace it)`,
    };
  }
  try {
    const written = await writeVaultFile(config.vaultRoot, rel, data);
    return { ok: true, ...written };
  } catch (err) {
    // 親セグメントが既存ファイル (assets/a.png/b.png 等) は mkdir が
    // EEXIST (親がファイル) / ENOTDIR (さらに深い階層) で落ちる。
    if (
      err instanceof Error &&
      'code' in err &&
      (err.code === 'ENOTDIR' || err.code === 'EEXIST')
    ) {
      return {
        ok: false,
        reason: 'conflict',
        message: `a parent segment is an existing file: ${rel}`,
      };
    }
    throw err;
  }
}

// ---- 添付削除 ----------------------------------------------------------------

/**
 * 添付ファイルを削除する (DELETE /api/files/{path} と同一のコア)。
 * 対象が存在すれば削除して { deleted: true }、なければ { deleted: false } を返す
 * (エラーにしない — 呼び出し側で「対象なし」/ 404 として扱う)。
 */
export async function deleteAttachment(
  config: ServerConfig,
  rel: string,
): Promise<{ deleted: boolean }> {
  const deleted = await deleteVaultFile(config.vaultRoot, rel);
  return { deleted };
}

// ---- 添付リネーム/移動 (![[リンク]] 追従) ------------------------------------

/**
 * 添付リネーム/移動 + vault 全体の ![[旧名]] 追従書き換え (POST /api/files/{path}/rename
 * と同一のコア)。notes rename と同じ compute-then-apply: 書き込みは全計算後。
 *
 *   - oldRel が存在しない   → { ok:false, reason:'not_found' }
 *   - newRel === oldRel     → 同名リネームは no-op (冪等。updatedNotes=[])
 *   - newRel が既存         → { ok:false, reason:'conflict' }
 *   - Phase 2 途中で失敗    → { ok:false, reason:'partial_failure' } (適用済みを明示)
 */
export type MoveAttachmentResult =
  | {
      ok: true;
      oldPath: string;
      path: string;
      mtime: number;
      updatedNotes: RenameUpdatedNote[];
      updatedLinks: number;
    }
  | { ok: false; reason: 'not_found'; message: string }
  | { ok: false; reason: 'conflict'; message: string }
  | { ok: false; reason: 'partial_failure'; message: string };

export async function moveAttachment(
  config: ServerConfig,
  index: VaultIndex,
  oldRel: string,
  newRel: string,
): Promise<MoveAttachmentResult> {
  const vaultRoot = config.vaultRoot;
  const source = await statVaultFile(vaultRoot, oldRel);
  if (source === null) {
    return { ok: false, reason: 'not_found', message: `file not found: ${oldRel}` };
  }
  if (newRel === oldRel) {
    return {
      ok: true,
      oldPath: oldRel,
      path: oldRel,
      mtime: source.mtime,
      updatedNotes: [],
      updatedLinks: 0,
    };
  }
  if ((await statVaultFile(vaultRoot, newRel)) !== null) {
    return { ok: false, reason: 'conflict', message: `rename target already exists: ${newRel}` };
  }

  // ---- Phase 1: 読み取りと書き換え計算のみ (ディスク書き込みゼロ) ----
  const fileSet = new Set((await listVaultFiles(vaultRoot)).map((f) => f.path));
  fileSet.add(oldRel);
  const before = [...fileSet];
  const after = before.map((p) => (p === oldRel ? newRel : p));
  const replacement = preferredFileLinkTarget(newRel, after);
  // 解決先が旧パスのリンクだけ書き換える (曖昧リンクは触らない — priority 2)。
  const shouldRewrite = (target: string): string | null =>
    resolveFileLinkTarget(target, before) === oldRel ? replacement : null;

  const sourceUpdates: { path: string; content: string; links: number }[] = [];
  for (const notePath of await listNoteFiles(vaultRoot)) {
    const content = await readNote(vaultRoot, notePath);
    if (content === null) continue; // 走査後に消えたノートは対象外
    const rewritten = rewriteLinks(content, shouldRewrite);
    if (rewritten.count > 0) {
      sourceUpdates.push({ path: notePath, content: rewritten.content, links: rewritten.count });
    }
  }

  // ---- Phase 2: 適用 (ファイル移動 → 参照元書き換え) ----
  const updatedNotes: RenameUpdatedNote[] = [];
  try {
    await moveVaultFile(vaultRoot, oldRel, newRel);
    for (const u of sourceUpdates) {
      await writeNote(vaultRoot, u.path, u.content);
      updatedNotes.push({ path: u.path, links: u.links });
    }
  } catch (err) {
    // 部分適用の隠蔽はしない (notes rename と同じ規約 — vault は Git 管理前提)。
    const appliedList = updatedNotes.map((u) => u.path).join(', ') || '(none)';
    return {
      ok: false,
      reason: 'partial_failure',
      message:
        `file rename was interrupted mid-apply (rewritten so far: ${appliedList}); ` +
        `the vault is git-managed — review \`git diff\` to recover. cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    };
  }

  // ---- インデックス即時追従 (リンク書き換えを検索・バックリンクへ反映) ----
  try {
    for (const u of sourceUpdates) await index.refreshFile(u.path);
  } catch (err) {
    // ファイルは正しく書けている。インデックスは chokidar / 再起動で自己修復する。
    console.error(`[loamium] index refresh after file rename failed:`, err);
  }

  const moved = await statVaultFile(vaultRoot, newRel);
  return {
    ok: true,
    oldPath: oldRel,
    path: newRel,
    mtime: moved?.mtime ?? source.mtime,
    updatedNotes,
    updatedLinks: updatedNotes.reduce((sum, u) => sum + u.links, 0),
  };
}
