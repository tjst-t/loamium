import { describe, expect, it } from 'vitest';
import {
  isValidJournalDate,
  JournalDateError,
  journalDayOfWeek,
  journalPath,
  shiftJournalDate,
  todayJournalDate,
} from './journal.js';

describe('isValidJournalDate', () => {
  it('accepts real dates', () => {
    expect(isValidJournalDate('2026-07-03')).toBe(true);
    expect(isValidJournalDate('2024-02-29')).toBe(true); // うるう年
  });

  it('rejects wrong formats', () => {
    expect(isValidJournalDate('2026-7-3')).toBe(false);
    expect(isValidJournalDate('20260703')).toBe(false);
    expect(isValidJournalDate('2026/07/03')).toBe(false);
    expect(isValidJournalDate('not-a-date')).toBe(false);
    expect(isValidJournalDate('')).toBe(false);
  });

  it('rejects non-existent calendar dates', () => {
    expect(isValidJournalDate('2026-02-30')).toBe(false);
    expect(isValidJournalDate('2025-02-29')).toBe(false); // 非うるう年
    expect(isValidJournalDate('2026-13-01')).toBe(false);
    expect(isValidJournalDate('2026-00-10')).toBe(false);
    expect(isValidJournalDate('2026-04-31')).toBe(false);
  });
});

describe('journalPath', () => {
  it('maps a date to journals/YYYY-MM-DD.md', () => {
    expect(journalPath('2026-07-03')).toBe('journals/2026-07-03.md');
  });

  it('throws JournalDateError for invalid dates', () => {
    expect(() => journalPath('2026-02-30')).toThrow(JournalDateError);
    expect(() => journalPath('bad')).toThrow(JournalDateError);
  });
});

describe('todayJournalDate', () => {
  it('formats in server-local timezone', () => {
    const d = new Date(2026, 0, 5, 23, 59, 0); // ローカル 2026-01-05
    expect(todayJournalDate(d)).toBe('2026-01-05');
  });

  it('pads month and day', () => {
    const d = new Date(2026, 8, 9); // 2026-09-09
    expect(todayJournalDate(d)).toBe('2026-09-09');
  });
});

describe('shiftJournalDate (Sa704c3: 前日/翌日ナビゲーション)', () => {
  it('shifts within a month', () => {
    expect(shiftJournalDate('2026-07-03', -1)).toBe('2026-07-02');
    expect(shiftJournalDate('2026-07-03', 1)).toBe('2026-07-04');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftJournalDate('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftJournalDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftJournalDate('2025-12-31', 1)).toBe('2026-01-01');
    expect(shiftJournalDate('2024-02-28', 1)).toBe('2024-02-29'); // うるう年
    expect(shiftJournalDate('2025-02-28', 1)).toBe('2025-03-01'); // 非うるう年
  });

  it('throws for invalid dates', () => {
    expect(() => shiftJournalDate('2026-02-30', 1)).toThrow(JournalDateError);
    expect(() => shiftJournalDate('bad', -1)).toThrow(JournalDateError);
  });
});

describe('journalDayOfWeek', () => {
  it('returns the Japanese day of week', () => {
    expect(journalDayOfWeek('2026-07-03')).toBe('金');
    expect(journalDayOfWeek('2026-07-05')).toBe('日');
  });

  it('throws for invalid dates', () => {
    expect(() => journalDayOfWeek('2026-13-01')).toThrow(JournalDateError);
  });
});
