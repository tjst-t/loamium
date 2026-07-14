/**
 * デイリージャーナルの日付処理。
 *
 * - ジャーナルは vault 内の journals/YYYY/MM/YYYY-MM-DD.md
 * - タイムゾーンはサーバーローカル (VISION: 個人用・自宅サーバー前提)
 */

export const JOURNAL_DIR = 'journals';

/**
 * 既定 journal テンプレートの vault 相対パス (S67ea41)。
 * templates/ 配下のピュア Markdown を正本とし、遅延生成時に適用する。
 * 存在しなければ従来どおり空ファイルで生成する(後方互換)。
 */
export const JOURNAL_TEMPLATE_PATH = 'templates/journal.md';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class JournalDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalDateError';
  }
}

/**
 * YYYY-MM-DD 形式かつ実在する日付かを検証する。
 */
export function isValidJournalDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  // Date でカレンダー逆算して実在チェック (2026-02-30 等を弾く)
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
  );
}

/**
 * 日付文字列から vault 相対のジャーナルパスを返す。
 * 年/月でサブディレクトリに分割する (journals/YYYY/MM/YYYY-MM-DD.md)。
 * 1 ディレクトリにファイルが際限なく溜まるのを防ぐため。
 * 無効な日付は JournalDateError を投げる。
 */
export function journalPath(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m || !isValidJournalDate(date)) {
    throw new JournalDateError(`invalid journal date: "${date}" (expected YYYY-MM-DD)`);
  }
  const [, year, month] = m;
  return `${JOURNAL_DIR}/${year}/${month}/${date}.md`;
}

/**
 * ジャーナル日付を delta 日ずらす (UI の前日/翌日ナビゲーション用)。
 * 月・年境界は Date のカレンダー計算に任せる。無効な日付は JournalDateError。
 */
export function shiftJournalDate(date: string, delta: number): string {
  if (!isValidJournalDate(date)) {
    throw new JournalDateError(`invalid journal date: "${date}" (expected YYYY-MM-DD)`);
  }
  const m = DATE_RE.exec(date);
  if (!m) throw new JournalDateError(`invalid journal date: "${date}"`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta);
  return todayJournalDate(d);
}

/**
 * ジャーナル日付の曜日 (日〜土)。UI 表示用。
 */
export function journalDayOfWeek(date: string): string {
  if (!isValidJournalDate(date)) {
    throw new JournalDateError(`invalid journal date: "${date}" (expected YYYY-MM-DD)`);
  }
  const m = DATE_RE.exec(date);
  if (!m) throw new JournalDateError(`invalid journal date: "${date}"`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = ['日', '月', '火', '水', '木', '金', '土'] as const;
  const dow = days[d.getDay()];
  if (dow === undefined) throw new JournalDateError(`invalid journal date: "${date}"`);
  return dow;
}

/**
 * ジャーナル日付文字列 (YYYY-MM-DD) を、サーバーローカルタイムゾーンで
 * その日の 00:00 を指す Date に変換する。テンプレートの `{{date:...}}` を
 * 対象日基準で展開するための基準日として使う (S67ea41)。
 * formatDate('YYYY-MM-DD', journalDateToLocalDate(d)) は d と一致する。
 * 無効な日付は JournalDateError。
 */
export function journalDateToLocalDate(date: string): Date {
  const m = DATE_RE.exec(date);
  if (!m || !isValidJournalDate(date)) {
    throw new JournalDateError(`invalid journal date: "${date}" (expected YYYY-MM-DD)`);
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * サーバーローカルタイムゾーンでの今日の日付 (YYYY-MM-DD)。
 */
export function todayJournalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
