/**
 * デイリージャーナルの日付処理。
 *
 * ⚠️ **UTC ではなくローカル日付で扱う。** ユーザーにとっての「今日」は端末の
 * ローカル日付であり、`toISOString()` を使うと日本時間の朝 9 時前に前日の
 * ジャーナルへ着地してしまう。
 */

export class JournalDateError extends Error {
  override readonly name = 'JournalDateError'
}

/** ジャーナルの既定フォルダ。vault 相対 */
export const JOURNAL_FOLDER = 'journals'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** `+3d` / `-1d` のような相対指定 */
const OFFSET = /^([+-]\d+)d$/

/** Date → `YYYY-MM-DD` (ローカル日付) */
export function formatJournalDate(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** `YYYY-MM-DD` → ローカル 0 時の Date */
export function parseJournalDate(iso: string): Date {
  const m = ISO_DATE.exec(iso)
  if (m === null) throw new JournalDateError(`日付は YYYY-MM-DD で指定してください: ${iso}`)
  const [, y, mo, d] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d))
  // 2026-02-30 のような「桁は合っているが存在しない日」を弾く (Date は繰り上げる)
  if (formatJournalDate(date) !== iso) throw new JournalDateError(`存在しない日付です: ${iso}`)
  return date
}

/**
 * ユーザー入力を `YYYY-MM-DD` に解決する。
 * `today` / `yesterday` / `tomorrow` / `+3d` / `-1d` / `YYYY-MM-DD` を受ける。
 * 未指定 (undefined / 空) は今日。
 */
export function resolveJournalDate(input?: string | null, now: Date = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const raw = (input ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'today') return formatJournalDate(today)
  if (raw === 'yesterday') return formatJournalDate(shiftDays(today, -1))
  if (raw === 'tomorrow') return formatJournalDate(shiftDays(today, 1))

  const offset = OFFSET.exec(raw)
  if (offset !== null) return formatJournalDate(shiftDays(today, Number(offset[1])))

  // ISO 形式はそのまま検証して返す (大文字小文字は関係ない)
  return formatJournalDate(parseJournalDate(raw))
}

/** 日付をずらす。月またぎ・うるう年は Date に任せる */
export function shiftDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** `YYYY-MM-DD` → vault 相対パス */
export function journalPath(date: string, folder: string = JOURNAL_FOLDER): string {
  return `${folder}/${date}.md`
}

/** 新規ジャーナルの初期内容。テンプレート機能が入るまでの既定 */
export function journalInitialContent(date: string): string {
  return `# ${date}\n`
}
