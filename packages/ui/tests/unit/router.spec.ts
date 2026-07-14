/**
 * 軽量ルーター (Sf1a90a-1) のユニットテスト。
 * URL ↔ Route の相互変換と、CJK/空白/.md 補完・未知パスのフォールバックを検証する
 * (DESIGN_PRINCIPLES: リンク・パス解決には必ずユニットテスト)。
 */
import { describe, expect, it } from 'vitest';
import {
  parseLocation,
  parseSearchParams,
  routeToPath,
  sameRoute,
  searchParamsToQuery,
  type Route,
} from '../../src/router.js';

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
  it('settings は /settings (Sa10026-9 #2)', () => {
    expect(routeToPath({ kind: 'settings' })).toBe('/settings');
  });
  it('search は条件を URL クエリに載せ、空値・既定 sort は省略する (S935867-1)', () => {
    expect(
      routeToPath({ kind: 'search', params: { q: 'バックアップ', tag: 'infra', folder: 'projects', sort: 'updated' } }),
    ).toBe('/search?q=%E3%83%90%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%97&tag=infra&folder=projects');
    expect(routeToPath({ kind: 'search', params: { q: '', tag: '', folder: '', sort: 'updated' } })).toBe('/search');
    expect(routeToPath({ kind: 'search', params: { q: 'x', tag: '', folder: '', sort: 'score' } })).toBe(
      '/search?q=x&sort=score',
    );
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
  it('/settings は設定ページ (Sa10026-9 #2)', () => {
    expect(parseLocation('/settings')).toEqual({ kind: 'settings' });
  });
  it('/ と未知パスは home', () => {
    expect(parseLocation('/')).toEqual({ kind: 'home' });
    expect(parseLocation('/n/')).toEqual({ kind: 'home' });
    expect(parseLocation('/unknown/path')).toEqual({ kind: 'home' });
  });
  it('/search はクエリを解釈する。pathname 埋め込み・search 引数どちらでも同じ (S935867-1)', () => {
    expect(parseLocation('/search?q=DNS&tag=infra&sort=score')).toEqual({
      kind: 'search',
      params: { q: 'DNS', tag: 'infra', folder: '', sort: 'score' },
    });
    expect(parseLocation('/search', '?q=DNS&folder=journals')).toEqual({
      kind: 'search',
      params: { q: 'DNS', tag: '', folder: 'journals', sort: 'updated' },
    });
    // 条件なしの /search も search ルート (空条件)
    expect(parseLocation('/search')).toEqual({
      kind: 'search',
      params: { q: '', tag: '', folder: '', sort: 'updated' },
    });
  });
  it('不正な sort は既定 updated へフォールバック', () => {
    expect(parseSearchParams('sort=bogus').sort).toBe('updated');
  });
  it('壊れた符号化は home へフォールバック', () => {
    expect(parseLocation('/n/%E0%A4%A')).toEqual({ kind: 'home' });
  });
  it('routeToPath → parseLocation の往復でノートパスが保存される', () => {
    const route: Route = { kind: 'note', path: 'reading/失敗の科学.md' };
    expect(parseLocation(routeToPath(route))).toEqual(route);
  });
  it('commands/*.yaml は .md を補完しない (ADR-0024)', () => {
    expect(parseLocation('/n/commands/create-todo.yaml')).toEqual({
      kind: 'note',
      path: 'commands/create-todo.yaml',
    });
  });
  it('routeToPath → parseLocation の往復で .yaml パスが保存される', () => {
    const route: Route = { kind: 'note', path: 'commands/create-todo.yaml' };
    expect(parseLocation(routeToPath(route))).toEqual(route);
  });
  it('routeToPath → parseLocation の往復で検索条件が保存される (S935867-1)', () => {
    const route: Route = {
      kind: 'search',
      params: { q: '設計 メモ', tag: 'infra dev', folder: 'projects', sort: 'name' },
    };
    expect(parseLocation(routeToPath(route))).toEqual(route);
  });
});

describe('searchParamsToQuery', () => {
  it('空条件は空文字、往復で parseSearchParams と一致する', () => {
    expect(searchParamsToQuery({ q: '', tag: '', folder: '', sort: 'updated' })).toBe('');
    const p = { q: 'a', tag: 'x y', folder: 'projects', sort: 'score' as const };
    expect(parseSearchParams(searchParamsToQuery(p))).toEqual(p);
  });
});

describe('sameRoute', () => {
  it('同一ノートパスは同一、異なるパス・種別は非同一', () => {
    expect(sameRoute({ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'a.md' })).toBe(true);
    expect(sameRoute({ kind: 'note', path: 'a.md' }, { kind: 'note', path: 'b.md' })).toBe(false);
    expect(sameRoute({ kind: 'files' }, { kind: 'files' })).toBe(true);
    expect(sameRoute({ kind: 'files' }, { kind: 'home' })).toBe(false);
  });
  it('search は条件が一致すれば同一、異なれば非同一', () => {
    const a: Route = { kind: 'search', params: { q: 'x', tag: '', folder: '', sort: 'updated' } };
    const b: Route = { kind: 'search', params: { q: 'x', tag: '', folder: '', sort: 'updated' } };
    const c: Route = { kind: 'search', params: { q: 'y', tag: '', folder: '', sort: 'updated' } };
    expect(sameRoute(a, b)).toBe(true);
    expect(sameRoute(a, c)).toBe(false);
  });
});
