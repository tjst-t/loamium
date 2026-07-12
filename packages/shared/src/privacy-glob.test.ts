/**
 * privacy-glob ユニットテスト (ADR-0014 / [AC-Sf4ee2f-1-3])。
 *
 * glob マッチングは壊れやすいロジックのため、境界・NFC ゆれ・大小・非マッチを網羅する。
 */
import { describe, expect, it } from 'vitest';
import { compilePrivacyMatcher } from './privacy-glob.js';

describe('[AC-Sf4ee2f-1-3] compilePrivacyMatcher', () => {
  it('空パターン配列は常に false (何も deny しない)', () => {
    const isDenied = compilePrivacyMatcher([]);
    expect(isDenied('private/secret.md')).toBe(false);
    expect(isDenied('anything.md')).toBe(false);
    expect(isDenied('')).toBe(false);
  });

  it('空文字列だけのパターンは無視される (常に false)', () => {
    const isDenied = compilePrivacyMatcher(['', '/', '///']);
    expect(isDenied('note.md')).toBe(false);
  });

  it('private/** はフォルダ配下すべてにマッチする', () => {
    const isDenied = compilePrivacyMatcher(['private/**']);
    expect(isDenied('private/secret.md')).toBe(true);
    expect(isDenied('private/sub/deep.md')).toBe(true);
    expect(isDenied('private/a/b/c/d.md')).toBe(true);
  });

  it('private/** は private というディレクトリ外にはマッチしない', () => {
    const isDenied = compilePrivacyMatcher(['private/**']);
    expect(isDenied('public/note.md')).toBe(false);
    expect(isDenied('private2/note.md')).toBe(false);
    // 境界: private2/ が private/ に誤マッチしないこと
    expect(isDenied('privatex.md')).toBe(false);
  });

  it('フォルダ名単体 (private) はそのパスと配下すべてにマッチする', () => {
    const isDenied = compilePrivacyMatcher(['private']);
    // private というノート自身
    expect(isDenied('private')).toBe(true);
    expect(isDenied('private.md')).toBe(false); // "private" リテラルは "private.md" とは別
    // private/ 配下
    expect(isDenied('private/secret.md')).toBe(true);
    expect(isDenied('private/sub/deep.md')).toBe(true);
    // 境界: private2/ は非マッチ
    expect(isDenied('private2/note.md')).toBe(false);
    expect(isDenied('privatestuff.md')).toBe(false);
  });

  it('個別ファイル指定にマッチする', () => {
    const isDenied = compilePrivacyMatcher(['secret.md']);
    expect(isDenied('secret.md')).toBe(true);
    expect(isDenied('notsecret.md')).toBe(false);
    expect(isDenied('dir/secret.md')).toBe(false); // ルート直下のみ
  });

  it('サブフォルダ内の個別ファイル指定にマッチする', () => {
    const isDenied = compilePrivacyMatcher(['finance/salary.md']);
    expect(isDenied('finance/salary.md')).toBe(true);
    expect(isDenied('salary.md')).toBe(false);
    expect(isDenied('finance/other.md')).toBe(false);
  });

  it('拡張子 glob (*.md) はルート直下の .md にマッチ、サブフォルダには非マッチ', () => {
    const isDenied = compilePrivacyMatcher(['*.md']);
    expect(isDenied('note.md')).toBe(true);
    expect(isDenied('another.md')).toBe(true);
    expect(isDenied('sub/note.md')).toBe(false); // * はスラッシュをまたがない
    expect(isDenied('note.txt')).toBe(false);
  });

  it('dir/*.md はそのフォルダ直下の .md のみにマッチ', () => {
    const isDenied = compilePrivacyMatcher(['drafts/*.md']);
    expect(isDenied('drafts/a.md')).toBe(true);
    expect(isDenied('drafts/sub/b.md')).toBe(false);
    expect(isDenied('a.md')).toBe(false);
  });

  it('? は 1 文字にマッチ (スラッシュはまたがない)', () => {
    const isDenied = compilePrivacyMatcher(['note?.md']);
    expect(isDenied('note1.md')).toBe(true);
    expect(isDenied('noteA.md')).toBe(true);
    expect(isDenied('note.md')).toBe(false); // 0 文字は非マッチ
    expect(isDenied('note12.md')).toBe(false); // 2 文字は非マッチ
  });

  it('** で任意深さの拡張子指定にマッチ (**/*.secret.md)', () => {
    const isDenied = compilePrivacyMatcher(['**/*.secret.md']);
    expect(isDenied('a.secret.md')).toBe(true);
    expect(isDenied('dir/b.secret.md')).toBe(true);
    expect(isDenied('a/b/c.secret.md')).toBe(true);
    expect(isDenied('normal.md')).toBe(false);
  });

  it('大文字小文字を吸収する (case-insensitive)', () => {
    const isDenied = compilePrivacyMatcher(['Private/**', 'Secret.md']);
    expect(isDenied('private/x.md')).toBe(true);
    expect(isDenied('PRIVATE/x.md')).toBe(true);
    expect(isDenied('secret.md')).toBe(true);
    expect(isDenied('SECRET.MD')).toBe(true);
  });

  it('NFC 正規化: 合成/分解ゆれのパスとパターンを吸収する', () => {
    // "é" 合成形 (U+00E9) と分解形 (e + U+0301)
    const composed = 'privé/note.md'.normalize('NFC');
    const decomposed = 'privé/note.md'; // NFD 相当 (未正規化)
    // パターン側を分解形で与えても、パス側を合成形で与えてもマッチする
    const isDenied = compilePrivacyMatcher(['privé/**']);
    expect(isDenied(composed)).toBe(true);
    expect(isDenied(decomposed)).toBe(true);
  });

  it('リテラルのドット等の正規表現メタ文字を誤解釈しない', () => {
    const isDenied = compilePrivacyMatcher(['a.b.md']);
    expect(isDenied('a.b.md')).toBe(true);
    expect(isDenied('aXb.md')).toBe(false); // '.' はワイルドカードではない
  });

  it('複数パターンのいずれかにマッチすれば true', () => {
    const isDenied = compilePrivacyMatcher(['private/**', '*.secret.md', 'finance/salary.md']);
    expect(isDenied('private/x.md')).toBe(true);
    expect(isDenied('a.secret.md')).toBe(true);
    expect(isDenied('finance/salary.md')).toBe(true);
    expect(isDenied('public/readme.md')).toBe(false);
  });

  it('先頭スラッシュ (絶対風) は vault 相対に正規化される', () => {
    const isDenied = compilePrivacyMatcher(['/private/**']);
    expect(isDenied('private/x.md')).toBe(true);
  });
});
