import { describe, it, expect } from 'vitest';
import { matchesCron, hasCronFireInRange } from './agent-scheduler.js';

describe('matchesCron', () => {
  it('毎分 (* * * * *)', () => {
    expect(matchesCron(new Date('2026-07-16T08:30:00'), '* * * * *')).toBe(true);
  });

  it('毎時00分 (0 * * * *)', () => {
    expect(matchesCron(new Date('2026-07-16T08:00:00'), '0 * * * *')).toBe(true);
    expect(matchesCron(new Date('2026-07-16T08:01:00'), '0 * * * *')).toBe(false);
  });

  it('毎朝8時 (0 8 * * *)', () => {
    expect(matchesCron(new Date('2026-07-16T08:00:00'), '0 8 * * *')).toBe(true);
    expect(matchesCron(new Date('2026-07-16T09:00:00'), '0 8 * * *')).toBe(false);
  });

  it('5分ごと (*/5 * * * *)', () => {
    expect(matchesCron(new Date('2026-07-16T08:00:00'), '*/5 * * * *')).toBe(true);
    expect(matchesCron(new Date('2026-07-16T08:05:00'), '*/5 * * * *')).toBe(true);
    expect(matchesCron(new Date('2026-07-16T08:03:00'), '*/5 * * * *')).toBe(false);
  });

  it('月曜0時 (0 0 * * 1)', () => {
    // 2026-07-20 は月曜日
    expect(matchesCron(new Date('2026-07-20T00:00:00'), '0 0 * * 1')).toBe(true);
    expect(matchesCron(new Date('2026-07-21T00:00:00'), '0 0 * * 1')).toBe(false);
  });

  it('カンマ区切り (0 8,20 * * *)', () => {
    expect(matchesCron(new Date('2026-07-16T08:00:00'), '0 8,20 * * *')).toBe(true);
    expect(matchesCron(new Date('2026-07-16T20:00:00'), '0 8,20 * * *')).toBe(true);
    expect(matchesCron(new Date('2026-07-16T12:00:00'), '0 8,20 * * *')).toBe(false);
  });

  it('範囲 (0 9-17 * * 1-5)', () => {
    // 平日9-17時の毎時0分
    // 2026-07-20 月曜日
    expect(matchesCron(new Date('2026-07-20T09:00:00'), '0 9-17 * * 1-5')).toBe(true);
    expect(matchesCron(new Date('2026-07-20T18:00:00'), '0 9-17 * * 1-5')).toBe(false);
    // 土曜
    expect(matchesCron(new Date('2026-07-18T09:00:00'), '0 9-17 * * 1-5')).toBe(false);
  });

  it('フィールド不足は false', () => {
    expect(matchesCron(new Date(), '* * * *')).toBe(false);
  });
});

describe('hasCronFireInRange', () => {
  it('範囲内に発火あり', () => {
    // 2026-07-16 08:00 は "0 8 * * *" の発火時刻
    const from = new Date('2026-07-15T08:00:00');
    const to = new Date('2026-07-16T09:00:00');
    expect(hasCronFireInRange('0 8 * * *', from, to)).toBe(true);
  });

  it('範囲内に発火なし', () => {
    const from = new Date('2026-07-16T08:01:00');
    const to = new Date('2026-07-16T09:59:00');
    expect(hasCronFireInRange('0 8 * * *', from, to)).toBe(false);
  });

  it('from と等しい時刻は含まない (from より後から検索)', () => {
    // from が発火時刻に一致していても、from 以降から探すので next は翌日
    const from = new Date('2026-07-16T08:00:00');
    const to = new Date('2026-07-16T08:00:00');
    expect(hasCronFireInRange('0 8 * * *', from, to)).toBe(false);
  });

  it('anacron: 複数日分のキャッチアップで 1 件ヒット', () => {
    const from = new Date('2026-07-10T00:00:00');
    const to = new Date('2026-07-16T12:00:00');
    // この範囲に "0 8 * * *" は複数回発火するが、hasCronFireInRange は true を返せばよい
    expect(hasCronFireInRange('0 8 * * *', from, to)).toBe(true);
  });
});
