import { describe, expect, it } from 'vitest';
import { chooseVersion } from './app-version.js';

describe('chooseVersion', () => {
  it('env を最優先する', () => {
    expect(chooseVersion('v1.2.3', '0.1.0')).toBe('v1.2.3');
  });

  it('先頭に v が無ければ付与して正規化する', () => {
    expect(chooseVersion('1.2.3', undefined)).toBe('v1.2.3');
    expect(chooseVersion(undefined, '0.1.0')).toBe('v0.1.0');
  });

  it('env が空文字/空白なら package.json へフォールバックする', () => {
    expect(chooseVersion('', '0.1.0')).toBe('v0.1.0');
    expect(chooseVersion('   ', '0.1.0')).toBe('v0.1.0');
  });

  it('前後の空白を除去する', () => {
    expect(chooseVersion(' v2.0.0 ', undefined)).toBe('v2.0.0');
  });

  it('いずれも無ければ undefined', () => {
    expect(chooseVersion(undefined, undefined)).toBeUndefined();
    expect(chooseVersion('', '')).toBeUndefined();
  });
});
