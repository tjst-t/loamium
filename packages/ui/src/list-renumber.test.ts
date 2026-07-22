/**
 * 順序リストのネスト採番 純関数のユニットテスト (S6848dc-5)。
 *
 * DOM 非依存 (node 環境の vitest)。`@codemirror/state` のみ使用し、
 * `@codemirror/view` (DOM 依存) は import しない。
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  renumberOrderedLists,
  renumberLines,
  renumberChangesForRange,
} from './list-renumber.js';

describe('renumberOrderedLists — 基本の連番', () => {
  it('トップレベルの兄弟は 1,2,3 で連番になる', () => {
    const input = ['1. a', '5. b', '9. c'].join('\n');
    expect(renumberOrderedLists(input)).toBe(['1. a', '2. b', '3. c'].join('\n'));
  });

  it('既に正しい番号は変更しない (冪等)', () => {
    const md = ['1. a', '2. b', '3. c'].join('\n');
    expect(renumberOrderedLists(md)).toBe(md);
    // もう一度通しても同じ
    expect(renumberOrderedLists(renumberOrderedLists(md))).toBe(md);
  });
});

describe('renumberOrderedLists — ネスト (AC-1)', () => {
  it('親 1. の下にインデントした子は 1. から始まる (親の連番を引き継がない)', () => {
    const input = ['1. 親', '    1. 子1', '    5. 子2', '2. 親2'].join('\n');
    // インデント 4 = CommonMark で子リスト。子は 1,2 で再開。親は 1,2。
    expect(renumberOrderedLists(input)).toBe(
      ['1. 親', '    1. 子1', '    2. 子2', '2. 親2'].join('\n'),
    );
  });

  it('子リストの後に戻ったトップレベル兄弟は連番を継続する', () => {
    const input = [
      '1. 親A',
      '    1. 子A1',
      '    1. 子A2',
      '1. 親B',
      '    1. 子B1',
      '1. 親C',
    ].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      [
        '1. 親A',
        '    1. 子A1',
        '    2. 子A2',
        '2. 親B',
        '    1. 子B1',
        '3. 親C',
      ].join('\n'),
    );
  });

  it('3 階層のネストがそれぞれ独立に 1 から採番される', () => {
    const input = [
      '1. L0-a',
      '    1. L1-a',
      '        1. L2-a',
      '        7. L2-b',
      '    9. L1-b',
      '3. L0-b',
    ].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      [
        '1. L0-a',
        '    1. L1-a',
        '        1. L2-a',
        '        2. L2-b',
        '    2. L1-b',
        '2. L0-b',
      ].join('\n'),
    );
  });
});

describe('renumberOrderedLists — インデント/アンインデント再計算 (AC-2)', () => {
  it('アンインデントで子が兄弟になると連番に取り込まれる', () => {
    // 元: 1. 親 / 子1 (indent) / 子2 (indent)。子2 をアンインデント → トップレベル。
    const afterUnindent = ['1. 親', '    1. 子1', '5. 元子2'].join('\n');
    expect(renumberOrderedLists(afterUnindent)).toBe(
      ['1. 親', '    1. 子1', '2. 元子2'].join('\n'),
    );
  });

  it('インデントで兄弟が子になると子リストとして 1 から始まる', () => {
    // 2 番目の項目をインデントした直後の生データ (番号は古いまま 2.)
    const afterIndent = ['1. 親', '    2. 元兄弟'].join('\n');
    expect(renumberOrderedLists(afterIndent)).toBe(
      ['1. 親', '    1. 元兄弟'].join('\n'),
    );
  });
});

describe('renumberOrderedLists — 途中項目の削除後 (AC-2)', () => {
  it('中間項目を削除しても残りが 1..n で再採番される', () => {
    // 元: 1,2,3,4 のうち 2 を削除した状態 (1,3,4 が残っている)
    const afterDelete = ['1. a', '3. c', '4. d'].join('\n');
    expect(renumberOrderedLists(afterDelete)).toBe(
      ['1. a', '2. c', '3. d'].join('\n'),
    );
  });
});

describe('renumberOrderedLists — マーカー種別/幅の保持', () => {
  it('箇条書き (- / * / +) 行は一切変更しない', () => {
    const md = ['- a', '* b', '+ c'].join('\n');
    expect(renumberOrderedLists(md)).toBe(md);
  });

  it('箇条書きと順序リストが混在しても順序リストだけ再採番', () => {
    const input = ['- bullet', '5. one', '9. two', '- bullet2'].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      ['- bullet', '1. one', '2. two', '- bullet2'].join('\n'),
    );
  });

  it('デリミタ ) を保持する', () => {
    const input = ['1) a', '5) b', '9) c'].join('\n');
    expect(renumberOrderedLists(input)).toBe(['1) a', '2) b', '3) c'].join('\n'));
  });

  it('デリミタ . と ) が同一インデントで混在すると別リスト扱いで各々 1 から', () => {
    const input = ['1. a', '2. b', '9) x', '9) y'].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      ['1. a', '2. b', '1) x', '2) y'].join('\n'),
    );
  });

  it('インデント幅 (先頭空白) を保持する', () => {
    // 2 スペースのインデントも保持されること
    const input = ['1. 親', '  5. 子1', '  8. 子2'].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      ['1. 親', '  1. 子1', '  2. 子2'].join('\n'),
    );
  });

  it('マーカー後の空白幅を保持する', () => {
    const input = ['1.   spaced', '4.   spaced2'].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      ['1.   spaced', '2.   spaced2'].join('\n'),
    );
  });
});

describe('renumberOrderedLists — 非リスト行・空行の扱い', () => {
  it('順序リストの前後の見出し・段落は変更しない', () => {
    const input = [
      '# タイトル',
      '',
      '段落テキスト。',
      '',
      '3. one',
      '7. two',
      '',
      '別の段落。',
    ].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      [
        '# タイトル',
        '',
        '段落テキスト。',
        '',
        '1. one',
        '2. two',
        '',
        '別の段落。',
      ].join('\n'),
    );
  });

  it('リスト項目内の複数行 (継続行) は番号として扱わない', () => {
    const input = ['1. 親', '    継続テキスト行', '5. 兄弟'].join('\n');
    expect(renumberOrderedLists(input)).toBe(
      ['1. 親', '    継続テキスト行', '2. 兄弟'].join('\n'),
    );
  });
});

describe('renumberLines — 配列 API (range 適用向け)', () => {
  it('入力配列を破壊しない (純粋関数)', () => {
    const input = ['5. a', '9. b'];
    const copy = [...input];
    renumberLines(input);
    expect(input).toEqual(copy);
  });

  it('同じ長さの配列を返す', () => {
    const input = ['1. a', 'text', '  - x', '9. b'];
    expect(renumberLines(input)).toHaveLength(input.length);
  });
});

describe('renumberChangesForRange — EditorState 統合 (DOM 非依存)', () => {
  const stateOf = (doc: string): EditorState => EditorState.create({ doc });

  it('影響範囲だけを含む ChangeSpec を返す (変わらない行はスキップ)', () => {
    // 1 行目は既に正しい (1.)、2 行目が 5. → 2. に直る
    const state = stateOf(['1. a', '5. b', '9. c'].join('\n'));
    const changes = renumberChangesForRange(state, 2, 2);
    // 変わる行だけ (2 行目 5→2, 3 行目 9→3。ブロック拡張で両方拾う)
    expect(changes.length).toBeGreaterThan(0);
    // 適用結果を検証
    const tr = state.update({ changes });
    expect(tr.state.doc.toString()).toBe(['1. a', '2. b', '3. c'].join('\n'));
  });

  it('ネストブロックを操作行から上下に拡張して整合させる', () => {
    const state = stateOf(
      ['1. 親', '    9. 子1', '    9. 子2', '2. 親2'].join('\n'),
    );
    // 2 行目 (子1) を起点に指定 → ブロック全体を再採番
    const changes = renumberChangesForRange(state, 2, 2);
    const tr = state.update({ changes });
    expect(tr.state.doc.toString()).toBe(
      ['1. 親', '    1. 子1', '    2. 子2', '2. 親2'].join('\n'),
    );
  });

  it('既に正しければ空の ChangeSpec を返す', () => {
    const state = stateOf(['1. a', '2. b'].join('\n'));
    expect(renumberChangesForRange(state, 1, 2)).toHaveLength(0);
  });

  it('範囲がドキュメント外でもクランプして安全', () => {
    const state = stateOf(['5. a'].join('\n'));
    const changes = renumberChangesForRange(state, 1, 999);
    const tr = state.update({ changes });
    expect(tr.state.doc.toString()).toBe('1. a');
  });
});
