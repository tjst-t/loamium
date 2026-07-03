import { describe, expect, it } from 'vitest';
import {
  isValidJournalDate,
  JournalDateError,
  journalPath,
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
