/**
 * 軽量ルーター (Sf1a90a-1) のユニットテスト。
 * URL ↔ Route の相互変換と、CJK/空白/.md 補完・未知パスのフォールバックを検証する
 * (DESIGN_PRINCIPLES: リンク・パス解決には必ずユニットテスト)。
 */
import { describe, expect, it } from 'vitest';
import { parseLocation, routeToPath, sameRoute, type Route } from '../../src/router.js';

describe('routeToPath', () => {
  it('ノートは /n/ + .md を除いたセグメント符号化', () => {
    expect(routeToPath({ kind: 'note', path: 'projects/Hydra 設計メモ.md' })).toBe(
      '/n/projects/Hydra%20%E8%A8%AD%E8%A8%88%E3%83%A1%E3%83%A2',
    );
  });
  it('ルート直下ノートも .md を除く', () => {
    expect(routeToPath({ kind: 'note', path: 'CodeMirror 6 調査.md' })).toBe(
      '/n/CodeMirror%206%20%E8%AA%BF%E6%9F%BB',
    );
  });
  it('files は /files、home は /', () => {
    expect(routeToPath({ kind: 'files' })).toBe('/files');
    expect(routeToPath({ kind: 'home' })).toBe('/');
  });
});

describe('parseLocation', () => {
  it('/n/{path} を復号し .md を補完する', () => {
    expect(parseLocation('/n/projects/Hydra%20%E8%A8%AD%E8%A8%88%E3%83%A1%E3%83%A2')).toEqual({
      kind: 'note',
      path: 'projects/Hydra 設計メモ.md',
    });
  });
  it('/files はファイル一覧', () => {
    expect(parseLocation('/files')).toEqual({ kind: 'files' });
  });
  it('/ と未知パスは home', () => {
    expect(parseLocation('/')).toEqual({ kind: 'home' });
    expect(parseLocation('/search')).toEqual({ kind: 'home' });
    expect(parseLocation('/n/')).toEqual({ kind: 'home' });
  });
  it('壊れた符号化は home へフォールバック', () => {
    expect(parseLocation('/n/%E0%A4%A')).toEqual({ kind: 'home' });
  });
  it('routeToPath → parseLocation の往復でノートパスが保存される', () => {
    const route: Route = { kind: 'note', path: 'reading/失敗の科学.md' };
    expect(parseLocation(routeToPath(route))).toEqual(route);
  });
});

describe('sameRoute', () => {
  it('同一ノートパスは同一、異なるパス・種別は非同一', () => {
    expect(sameRoute({ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'a.md' })).toBe(true);
    expect(sameRoute({ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'b.md' })).toBe(false);
    expect(sameRoute({ kind: 'files' }, { kind: 'files' })).toBe(true);
    expect(sameRoute({ kind: 'files' }, { kind: 'home' })).toBe(false);
  });
});
