/**
 * parseMaxUpload / configFromEnv のユニットテスト。
 */
import { describe, expect, it } from 'vitest';
import { parseMaxUpload } from './config.js';

describe('parseMaxUpload', () => {
  it('素の整数はバイトとして解釈する', () => {
    expect(parseMaxUpload('1024')).toBe(1024);
  });

  it('kb / mb / gb の単位付きを変換する (大小不区別)', () => {
    expect(parseMaxUpload('512kb')).toBe(512 * 1024);
    expect(parseMaxUpload('50MB')).toBe(50 * 1024 * 1024);
    expect(parseMaxUpload('1GB')).toBe(1024 ** 3);
  });

  it('不正な値は例外を投げる', () => {
    expect(() => parseMaxUpload('notanumber')).toThrow(/invalid LOAMIUM_MAX_UPLOAD/);
    expect(() => parseMaxUpload('')).toThrow(/invalid LOAMIUM_MAX_UPLOAD/);
  });
});
