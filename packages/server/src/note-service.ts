/**
 * ノート書き込みサービス層 (ADR-0016)。
 *
 * REST ルート (notes.ts / journal.ts) とエージェント書き込みツール
 * (agent-write-tools.ts) の**両方**が呼ぶ単一のサービス層。
 *
 * ADR-0016 契約: エージェント専用の書き込み実装を新設しない。書き込みロジックを
 * ここへ集約し、REST も CLI もエージェントも同じコードを通す。これにより
 * ピュア Markdown 出力・normalizeVaultPath・[[リンク]] 追従・.loamium/audit.log
 * の扱いを 1 箇所で担保する (二重管理の排除)。
 *
 * 戻り値は throw ではなく**判別可能な結果型**にする。ルート (HTTP ステータス) と
 * ツール (テキスト結果) の両方が同じセマンティクス (not_found / ambiguous / exists) を
 * 分岐で扱えるようにするため。低レベル file 操作 (vault.ts) の例外 (I/O 障害等) は
 * そのまま伝播させる (握りつぶさない — DESIGN_PRINCIPLES priority 2)。
 */
import {
  appendText,
  countOccurrences,
  isValidJournalDate,
  journalPath,
  todayJournalDate,
  preferredLinkTarget,
  resolveLinkTarget,
  rewriteLinks,
  JournalDateError,
  type RenameUpdatedNote,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { deleteNote, listNoteFiles, noteMtime, readNote, writeNote } from './vault.js';

// ---- 結果型 ------------------------------------------------------------------

/** 書き込み成功。mtime は書き込み後のファイル mtime (ms epoch)。 */
export interface WriteOk {
  ok: true;
  mtime: number;
  /** 新規作成なら true (append/patch は false)。 */
  created: boolean;
}

/**
 * 書き込み失敗 (判別可能)。
 * - not_found   : 対象ノートが存在しない (append / patch)。
 * - old_missing : patch の old が 0 箇所 (置換対象なし)。
 * - ambiguous   : patch の old が複数箇所にマッチ (曖昧なので実行しない)。
 * - exists      : createNote で対象パスが既存 (上書きしない)。
 */
export interface WriteErr {
  ok: false;
  reason: 'not_found' | 'old_missing' | 'ambiguous' | 'exists';
  message: string;
}

export type WriteResult = WriteOk | WriteErr;

// ---- ノート書き込み ----------------------------------------------------------

/**
 * ノート末尾に追記する (REST: POST /api/notes/{path}/append)。
 * 対象が存在しなければ not_found (作成はしない — REST は 404 相当)。
 * appendText で末尾改行を整える (ピュア Markdown・LF)。
 */
export async function appendToNote(
  config: ServerConfig,
  rel: string,
  text: string,
): Promise<WriteResult> {
  const existing = await readNote(config.vaultRoot, rel);
  if (existing === null) {
    return { ok: false, reason: 'not_found', message: `note not found: ${rel}` };
  }
  const written = await writeNote(config.vaultRoot, rel, appendText(existing, text));
  return { ok: true, mtime: written.mtime, created: false };
}

/**
 * ノートの old→new 部分置換 (REST: POST /api/notes/{path}/patch)。非破壊 patch。
 * - 対象が存在しない → not_found
 * - old が 0 箇所      → not_found (置換対象なし)
 * - old が 2 箇所以上   → ambiguous (データ安全性 priority 2: 曖昧な置換はしない)
 * new の $& / $' 等の特殊解釈を避けるため関数形式で置換する。
 */
export async function patchNote(
  config: ServerConfig,
  rel: string,
  oldText: string,
  newText: string,
): Promise<WriteResult> {
  const existing = await readNote(config.vaultRoot, rel);
  if (existing === null) {
    return { ok: false, reason: 'not_found', message: `note not found: ${rel}` };
  }
  const count = countOccurrences(existing, oldText);
  if (count === 0) {
    return { ok: false, reason: 'old_missing', message: 'old string not found in note' };
  }
  if (count > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `old string matches ${String(count)} locations; provide a more specific old string`,
    };
  }
  const updated = existing.replace(oldText, () => newText);
  const written = await writeNote(config.vaultRoot, rel, updated);
  return { ok: true, mtime: written.mtime, created: false };
}

/**
 * ノートを新規作成する (上書きしない)。
 * 対象パスが既存なら exists を返し、ファイルには一切触れない (非破壊)。
 * content はピュア Markdown 文字列としてそのまま書く (LF は writeNote が固定)。
 */
export async function createNote(
  config: ServerConfig,
  rel: string,
  content: string,
): Promise<WriteResult> {
  if ((await noteMtime(config.vaultRoot, rel)) !== null) {
    return { ok: false, reason: 'exists', message: `note already exists: ${rel}` };
  }
  const written = await writeNote(config.vaultRoot, rel, content);
  return { ok: true, mtime: written.mtime, created: written.created };
}

/**
 * ノートを作成 or 上書きする (PUT /api/notes/{path} と同一のフル置換セマンティクス)。
 * 既存でも書き込む (created は新規作成か否か)。content はピュア Markdown 文字列。
 * 上書き対応が必要なテンプレート authoring (template_write overwrite) で使う。
 */
export async function upsertNote(
  config: ServerConfig,
  rel: string,
  content: string,
): Promise<WriteOk> {
  const written = await writeNote(config.vaultRoot, rel, content);
  return { ok: true, mtime: written.mtime, created: written.created };
}

/**
 * ノートを削除する (REST: DELETE /api/notes/{path} と同一のサービス層)。
 * 対象が存在すれば削除して { deleted: true }、存在しなければ { deleted: false } を返す
 * (エラーにしない — 呼び出し側で「対象なし」として扱う)。
 */
export async function deleteNoteFile(
  config: ServerConfig,
  rel: string,
): Promise<{ deleted: boolean }> {
  const deleted = await deleteNote(config.vaultRoot, rel);
  return { deleted };
}

/**
 * ジャーナル (journals/YYYY/MM/YYYY-MM-DD.md) の末尾に追記する
 * (REST: POST /api/journal/append)。
 * date 未指定 (null/undefined) は今日 (サーバーローカル)。存在しなければ作成して追記する。
 * 無効な日付は JournalDateError を投げる (呼び出し側で 400 / エラーテキストに写像)。
 */
export async function appendToJournal(
  config: ServerConfig,
  date: string | null | undefined,
  text: string,
): Promise<{ date: string; rel: string; result: WriteResult }> {
  const d = date ?? todayJournalDate();
  if (!isValidJournalDate(d)) {
    throw new JournalDateError(`invalid journal date: "${d}" (expected YYYY-MM-DD)`);
  }
  const rel = journalPath(d);
  const existing = await readNote(config.vaultRoot, rel);
  const created = existing === null;
  const written = await writeNote(config.vaultRoot, rel, appendText(existing ?? '', text));
  return { date: d, rel, result: { ok: true, mtime: written.mtime, created } };
}

// ---- ノートのリネーム/移動 (リンク追従) --------------------------------------

/**
 * ノートのリネーム/移動 + vault 全体の [[旧名]] 追従書き換え (ADR-0016)。
 *
 * POST /api/notes/{path}/rename の 2 フェーズ compute-then-apply を純関数として抽出し、
 * REST とエージェント (note_move) の両方から呼ぶ (二重管理の排除)。挙動は REST と同一:
 *
 *   - oldRel が存在しない        → { ok:false, reason:'not_found' }
 *   - newRel === oldRel          → 同名リネームは no-op (冪等。updatedNotes=[])
 *   - newRel が既存              → { ok:false, reason:'conflict' }
 *   - Phase 2 の途中で失敗       → { ok:false, reason:'partial_failure' } (適用済みを明示)
 *
 * データ安全性 (priority 2): 書き込みは全計算 (Phase 1) が終わってから。移動先が既存なら
 * 拒否し、解決先が旧パスであるリンクだけを書き換える (曖昧リンクは触らない)。
 * インデックスはファイルシステム走査で計算する (ファイルが正 — priority 6)。
 */
export type RenameNoteResult =
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

export async function renameNote(
  config: ServerConfig,
  index: VaultIndex,
  oldRel: string,
  newRel: string,
): Promise<RenameNoteResult> {
  const vaultRoot = config.vaultRoot;
  const oldContent = await readNote(vaultRoot, oldRel);
  if (oldContent === null) {
    return { ok: false, reason: 'not_found', message: `note not found: ${oldRel}` };
  }
  if (newRel === oldRel) {
    // 同名リネームは no-op (冪等)
    const mtime = await noteMtime(vaultRoot, oldRel);
    return {
      ok: true,
      oldPath: oldRel,
      path: oldRel,
      mtime: mtime ?? 0,
      updatedNotes: [],
      updatedLinks: 0,
    };
  }
  if ((await noteMtime(vaultRoot, newRel)) !== null) {
    return { ok: false, reason: 'conflict', message: `rename target already exists: ${newRel}` };
  }

  // ---- Phase 1: 読み取りと書き換え計算のみ (この間ディスクへの書き込みゼロ) ----
  // インデックスではなくファイルシステムを走査する (priority 6: ファイルが正)。
  const pathSet = new Set(await listNoteFiles(vaultRoot));
  pathSet.add(oldRel);
  const before = [...pathSet];
  const after = before.map((p) => (p === oldRel ? newRel : p));
  // 書き換え後リンクは新パスに必ず解決する最短表記 (basename 衝突時はフルパス)
  const replacement = preferredLinkTarget(newRel, after);
  // 解決先が旧パスのリンクだけ書き換える。同名 basename が別ノートに解決される
  // 曖昧リンクは対象外 (勝手に付け替えない — priority 2)。
  const shouldRewrite = (target: string): string | null =>
    resolveLinkTarget(target, before) === oldRel ? replacement : null;

  let movedContent = oldContent;
  let selfLinks = 0;
  const sourceUpdates: { path: string; content: string; links: number }[] = [];
  for (const p of before) {
    const content = p === oldRel ? oldContent : await readNote(vaultRoot, p);
    if (content === null) continue; // 走査後に消えたファイルは対象外
    const rewritten = rewriteLinks(content, shouldRewrite);
    if (p === oldRel) {
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
    written = await writeNote(vaultRoot, newRel, movedContent);
    await deleteNote(vaultRoot, oldRel);
    if (selfLinks > 0) updatedNotes.push({ path: newRel, links: selfLinks });
    for (const u of sourceUpdates) {
      await writeNote(vaultRoot, u.path, u.content);
      updatedNotes.push({ path: u.path, links: u.links });
    }
  } catch (err) {
    // 部分適用の隠蔽はしない: どこまで適用されたかを明示して返す
    // (vault は Git 管理前提 — VISION。ユーザーが差分を確認して復旧できる)
    const appliedList = updatedNotes.map((u) => u.path).join(', ') || '(none)';
    return {
      ok: false,
      reason: 'partial_failure',
      message:
        `rename was interrupted mid-apply (rewritten so far: ${appliedList}); ` +
        `the vault is git-managed — review \`git diff\` to recover. cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    };
  }

  // ---- インデックス即時追従 (audit ミドルウェアの単一パス更新では足りない) ----
  index.removeFile(oldRel);
  try {
    await index.refreshFile(newRel);
    for (const u of sourceUpdates) await index.refreshFile(u.path);
  } catch (err) {
    // ファイルは正しく書けている。インデックスは chokidar / 再起動で自己修復する
    console.error(`[loamium] index refresh after rename failed:`, err);
  }

  return {
    ok: true,
    oldPath: oldRel,
    path: newRel,
    mtime: written.mtime,
    updatedNotes,
    updatedLinks: updatedNotes.reduce((sum, u) => sum + u.links, 0),
  };
}
