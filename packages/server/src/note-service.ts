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
  JournalDateError,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { noteMtime, readNote, writeNote } from './vault.js';

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
