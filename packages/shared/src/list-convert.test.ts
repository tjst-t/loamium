/**
 * リストタイプ変換 (箇条書き ⇄ 番号付き) 純関数のユニットテスト (S6848dc-6)。
 *
 * DOM / CodeMirror 非依存 (node 環境の vitest)。文字列 → 文字列のみを検証する。
 * 採番の既存テストは packages/ui/src/list-renumber.test.ts が担う (re-export)。
 */
import { describe, it, expect } from 'vitest';
import { convertListLines, convertListMarkdown } from './list-convert.js';

describe('convertListMarkdown — bullet → ordered (AC-3 採番)', () => {
  it('トップレベルの箇条書きを 1,2,3 で番号付けする', () => {
    const md = ['- a', '- b', '- c'].join('\n');
    expect(convertListMarkdown(md, 'ordered')).toBe(['1. a', '2. b', '3. c'].join('\n'));
  });

  it('* / + マーカーも番号付きへ変換する', () => {
    const md = ['* a', '+ b'].join('\n');
    expect(convertListMarkdown(md, 'ordered')).toBe(['1. a', '2. b'].join('\n'));
  });

  it('ネストした子箇条書きは 1 から採番する (親の連番を引き継がない)', () => {
    const md = ['- a', '    - x', '    - y', '- b'].join('\n');
    expect(convertListMarkdown(md, 'ordered')).toBe(
      ['1. a', '    1. x', '    2. y', '2. b'].join('\n'),
    );
  });

  it('インデント (先頭空白) を保持する', () => {
    const md = ['    - deep'].join('\n');
    expect(convertListMarkdown(md, 'ordered')).toBe(['    1. deep'].join('\n'));
  });
});

describe('convertListMarkdown — ordered → bullet (AC-4)', () => {
  it('番号付きを既定マーカー `-` の箇条書きへ変換する', () => {
    const md = ['1. a', '2. b', '3. c'].join('\n');
    expect(convertListMarkdown(md, 'bullet')).toBe(['- a', '- b', '- c'].join('\n'));
  });

  it('`1)` デリミタの順序リストも箇条書きへ変換する', () => {
    const md = ['1) a', '2) b'].join('\n');
    expect(convertListMarkdown(md, 'bullet')).toBe(['- a', '- b'].join('\n'));
  });

  it('マーカー後の空白を保持する (1.<space><space>x → -<space><space>x)', () => {
    const md = ['1.  spaced'].join('\n');
    expect(convertListMarkdown(md, 'bullet')).toBe(['-  spaced'].join('\n'));
  });

  it('同じ階層に既存の箇条書きマーカーがあればそれに合わせる (* を優先)', () => {
    // 先頭が * 箇条書き、続く順序行 → bullet 変換時に * を使う
    const md = ['* a', '1. b'].join('\n');
    expect(convertListMarkdown(md, 'bullet')).toBe(['* a', '* b'].join('\n'));
  });
});

describe('convertListLines — チェックボックス保持 (decisions)', () => {
  it('bullet → ordered でチェックボックスをコンテンツとして温存する', () => {
    const lines = ['- [ ] todo', '- [x] done'];
    expect(convertListLines(lines, 'ordered')).toEqual(['1. [ ] todo', '2. [x] done']);
  });

  it('ordered → bullet で round-trip できる (チェックボックス復帰)', () => {
    const lines = ['1. [ ] todo', '2. [x] done'];
    expect(convertListLines(lines, 'bullet')).toEqual(['- [ ] todo', '- [x] done']);
  });

  it('インラインフィールドを含むタスク行のコンテンツを保持する', () => {
    const lines = ['- [ ] task [due:: 2026-07-21]'];
    expect(convertListLines(lines, 'ordered')).toEqual(['1. [ ] task [due:: 2026-07-21]']);
  });
});

describe('convertListLines — 非リスト行・混在・冪等', () => {
  it('非リスト行 (見出し・段落・空行) はそのまま', () => {
    const lines = ['# 見出し', '', '段落', '- a', ''];
    expect(convertListLines(lines, 'ordered')).toEqual(['# 見出し', '', '段落', '1. a', '']);
  });

  it('リストと段落が混在しても段落を挟んで別リストとして採番する', () => {
    const lines = ['- a', '- b', '', 'テキスト', '', '- c'];
    expect(convertListLines(lines, 'ordered')).toEqual([
      '1. a',
      '2. b',
      '',
      'テキスト',
      '',
      '1. c',
    ]);
  });

  it('既に目的タイプなら変更しない (bullet → bullet は冪等)', () => {
    const lines = ['- a', '- b'];
    expect(convertListLines(lines, 'bullet')).toEqual(['- a', '- b']);
  });

  it('ordered → ordered は採番のみ正規化する (冪等・番号詰め)', () => {
    const lines = ['5. a', '9. b'];
    expect(convertListLines(lines, 'ordered')).toEqual(['1. a', '2. b']);
  });

  it('LF 改行コードを保持する (末尾改行含む)', () => {
    const md = '- a\n- b\n';
    expect(convertListMarkdown(md, 'ordered')).toBe('1. a\n2. b\n');
  });
});
