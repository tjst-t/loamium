/**
 * parseAllowedOrigins / terminalConfigFromEnv のユニットテスト (S79c210-3)。
 */
import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins, terminalConfigFromEnv } from './config.js';

describe('parseAllowedOrigins', () => {
  it('未設定・空文字は空配列', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });

  it('カンマ区切りを URL.origin へ正規化する', () => {
    expect(parseAllowedOrigins('http://10.10.254.36:8203, https://notes.lan')).toEqual([
      'http://10.10.254.36:8203',
      'https://notes.lan',
    ]);
  });

  it('末尾スラッシュやパスは origin へ畳まれる', () => {
    expect(parseAllowedOrigins('http://10.10.254.36:8203/')).toEqual(['http://10.10.254.36:8203']);
  });

  it('パース不能なオリジンは無視する (壊れた設定でガードを緩めない)', () => {
    expect(parseAllowedOrigins('not-a-url, http://ok.lan')).toEqual(['http://ok.lan']);
  });
});

describe('terminalConfigFromEnv allowedOrigins', () => {
  it('有効時に allowedOrigins を含める', () => {
    const cfg = terminalConfigFromEnv(
      { LOAMIUM_TERMINAL: '1', LOAMIUM_TERMINAL_ALLOWED_ORIGINS: 'http://10.10.254.36:8203' },
      'full',
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowedOrigins).toEqual(['http://10.10.254.36:8203']);
  });

  it('無効時 (env 未設定) でも allowedOrigins は解釈される', () => {
    const cfg = terminalConfigFromEnv({ LOAMIUM_TERMINAL_ALLOWED_ORIGINS: 'https://notes.lan' }, 'full');
    expect(cfg.enabled).toBe(false);
    expect(cfg.allowedOrigins).toEqual(['https://notes.lan']);
  });
});
