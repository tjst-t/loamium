/**
 * デイリージャーナルの日付処理。
 *
 * - ジャーナルは vault 内の journals/YYYY-MM-DD.md
 * - タイムゾーンはサーバーローカル (VISION: 個人用・自宅サーバー前提)
 */

export const JOURNAL_DIR = 'journals';

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
 * 無効な日付は JournalDateError を投げる。
 */
export function journalPath(date: string): string {
  if (!isValidJournalDate(date)) {
    throw new JournalDateError(`invalid journal date: "${date}" (expected YYYY-MM-DD)`);
  }
  return `${JOURNAL_DIR}/${date}.md`;
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
