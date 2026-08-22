/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import {
  formatJournalDate, parseJournalDate, resolveJournalDate, shiftDays,
  journalPath, journalInitialContent, JournalDateError,
} from '../journal'

// 固定の「今」。ローカル時刻の 0:30 — UTC 換算だと前日になる時刻をあえて選ぶ
const NOW = new Date(2026, 7, 22, 0, 30) // 2026-08-22 00:30 ローカル

describe('ジャーナルの日付解決', () => {
  it('ローカル日付で返す (UTC にずらさない)', () => {
    expect(resolveJournalDate(undefined, NOW)).toBe('2026-08-22')
    expect(formatJournalDate(NOW)).toBe('2026-08-22')
  })

  it.each([
    ['', '2026-08-22'],
    ['today', '2026-08-22'],
    ['yesterday', '2026-08-21'],
    ['tomorrow', '2026-08-23'],
    ['+3d', '2026-08-25'],
    ['-1d', '2026-08-21'],
    ['2026-01-05', '2026-01-05'],
  ])('%s → %s', (input, expected) => {
    expect(resolveJournalDate(input, NOW)).toBe(expected)
  })

  it('月またぎ・うるう年を跨げる', () => {
    expect(resolveJournalDate('+10d', new Date(2026, 11, 25))).toBe('2027-01-04')
    expect(resolveJournalDate('+1d', new Date(2028, 1, 28))).toBe('2028-02-29')
  })

  it.each(['2026-8-22', '20260822', '来週', '2026-02-30', '2026-13-01'])(
    '不正な日付 %s は拒否する', (bad) => {
      expect(() => resolveJournalDate(bad, NOW)).toThrow(JournalDateError)
    })

  it('shiftDays は月境界で正しく繰り上がる', () => {
    expect(formatJournalDate(shiftDays(new Date(2026, 7, 31), 1))).toBe('2026-09-01')
    expect(formatJournalDate(shiftDays(new Date(2026, 7, 1), -1))).toBe('2026-07-31')
  })

  it('parseJournalDate はローカル 0 時を返す', () => {
    const d = parseJournalDate('2026-08-22')
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 7, 22, 0])
  })
})

describe('ジャーナルのパスと初期内容', () => {
  it('既定は journals/YYYY-MM-DD.md', () => {
    expect(journalPath('2026-08-22')).toBe('journals/2026-08-22.md')
  })

  it('フォルダを差し替えられる', () => {
    expect(journalPath('2026-08-22', '日誌')).toBe('日誌/2026-08-22.md')
  })

  it('初期内容は日付の見出しだけ (独自記法を書き込まない)', () => {
    expect(journalInitialContent('2026-08-22')).toBe('# 2026-08-22\n')
  })
})
