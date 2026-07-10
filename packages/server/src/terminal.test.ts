/**
 * isAllowedOrigin (CSWSH Origin 検査) のユニットテスト (S79c210-3)。
 * 実 WS の許可/拒否は tests/acceptance/terminal.spec.ts が本番モードで検証する。
 */
import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './terminal.js';

describe('isAllowedOrigin', () => {
  const HOST = '127.0.0.1:8080';

  it('Origin 無し (非ブラウザ) は許可する', () => {
    expect(isAllowedOrigin(undefined, HOST)).toBe(true);
    expect(isAllowedOrigin('', HOST)).toBe(true);
  });

  it('same-origin (host 完全一致) は許可する', () => {
    expect(isAllowedOrigin('http://127.0.0.1:8080', HOST)).toBe(true);
  });

  it('ループバック hostname は許可する', () => {
    expect(isAllowedOrigin('http://localhost:5173', HOST)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', HOST)).toBe(true);
  });

  it('列挙外の非ループバックオリジンは既定 (空リスト) で拒否する', () => {
    expect(isAllowedOrigin('http://10.10.254.36:8203', HOST)).toBe(false);
    expect(isAllowedOrigin('http://evil.example', HOST)).toBe(false);
  });

  it('許可リストに列挙したオリジンは許可する', () => {
    const allow = ['http://10.10.254.36:8203', 'https://notes.lan'];
    expect(isAllowedOrigin('http://10.10.254.36:8203', HOST, allow)).toBe(true);
    expect(isAllowedOrigin('https://notes.lan', HOST, allow)).toBe(true);
    // 列挙外は依然拒否
    expect(isAllowedOrigin('http://10.10.254.99:9999', HOST, allow)).toBe(false);
  });

  it('許可リストの一致は origin (scheme+host+port) 単位で、パス付きでも一致する', () => {
    const allow = ['http://10.10.254.36:8203'];
    // Origin ヘッダは通常パスを含まないが、URL.origin 正規化で一致する
    expect(isAllowedOrigin('http://10.10.254.36:8203', HOST, allow)).toBe(true);
    // ポート違いは別オリジンなので拒否
    expect(isAllowedOrigin('http://10.10.254.36:9000', HOST, allow)).toBe(false);
  });

  it('壊れた Origin は拒否する', () => {
    expect(isAllowedOrigin('not-a-url', HOST)).toBe(false);
  });

  it('サブドメインワイルドカードは配下のサブドメインを許可する (port 任意)', () => {
    const allow = ['*.tjstkm.net'];
    expect(isAllowedOrigin('https://notes.tjstkm.net', HOST, allow)).toBe(true);
    expect(isAllowedOrigin('http://a.b.tjstkm.net:8443', HOST, allow)).toBe(true);
    // apex 自体はサブドメインでないので拒否
    expect(isAllowedOrigin('https://tjstkm.net', HOST, allow)).toBe(false);
    // サフィックス偽装 (eviltjstkm.net) はドット境界不一致で拒否
    expect(isAllowedOrigin('https://eviltjstkm.net', HOST, allow)).toBe(false);
    // 別ドメインは拒否
    expect(isAllowedOrigin('https://notes.example.com', HOST, allow)).toBe(false);
  });

  it('scheme 付きワイルドカードは scheme を限定する', () => {
    const allow = ['https://*.tjstkm.net'];
    expect(isAllowedOrigin('https://notes.tjstkm.net', HOST, allow)).toBe(true);
    // http は許可 scheme (https) と不一致なので拒否
    expect(isAllowedOrigin('http://notes.tjstkm.net', HOST, allow)).toBe(false);
  });
});
