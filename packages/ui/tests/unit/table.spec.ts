/**
 * GFM テーブルのセル分解 (splitTableRow) と WYSIWYG 編集の直列化モデルの
 * ユニットテスト (S79c210-2 / Sd40b63-1)。
 * Markdown パーサー相当のため必須 (DESIGN_PRINCIPLES coding_conventions)。
 * DOM 描画 (renderMarkdownTable) は table-render / table-edit の mock/e2e が検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  splitTableRow,
  parseTableModel,
  serializeTableModel,
  toEditable,
  toSource,
  addRow,
  addColumn,
  deleteRow,
  deleteColumn,
} from '../../src/renderers/table';

describe('splitTableRow', () => {
  it('前後のパイプを剥がしてセルへ分解する', () => {
    expect(splitTableRow('| 商品 | 個数 | 状態 |')).toEqual(['商品', '個数', '状態']);
  });

  it('前後にパイプが無くても分解する', () => {
    expect(splitTableRow('a | b | c')).toEqual(['a', 'b', 'c']);
  });

  it('各セルの前後空白をトリムする', () => {
    expect(splitTableRow('|  x  |   y|')).toEqual(['x', 'y']);
  });

  it('エスケープした \\| はセル区切りにしない', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
  });

  it('空セルは空文字列として保持する', () => {
    expect(splitTableRow('|  |  |  |')).toEqual(['', '', '']);
  });

  it('区切り行 (揃え指定) も同じ規則で分解できる', () => {
    expect(splitTableRow('| :--- | :---: | ---: |')).toEqual([':---', ':---:', '---:']);
  });
});

describe('toEditable / toSource (パイプのエスケープのみを扱う)', () => {
  it('編集用は \\| を | へ戻す', () => {
    expect(toEditable('a \\| b')).toBe('a | b');
  });

  it('ソース化は | を \\| へエスケープする', () => {
    expect(toSource('a | b')).toBe('a \\| b');
  });

  it('パイプ以外のバックスラッシュは触らない (未編集セルを壊さない)', () => {
    expect(toEditable('\\frac \\\\ x')).toBe('\\frac \\\\ x');
    expect(toSource('\\frac \\\\ x')).toBe('\\frac \\\\ x');
  });

  it('| ↔ \\| は完全な逆変換になる', () => {
    const editable = 'a | b | c';
    expect(toEditable(toSource(editable))).toBe(editable);
  });

  it('セル内改行は空白へ潰す', () => {
    expect(toSource('a\nb')).toBe('a b');
  });
});

describe('parseTableModel / serializeTableModel', () => {
  const lines = [
    '| 商品 | 個数 | 状態 |',
    '| --- | ---: | :---: |',
    '| りんご | 12 | 在庫 |',
    '| みかん | 3 | 補充中 |',
  ];

  it('ヘッダ・揃え・データ行を編集モデルへ分解する', () => {
    const m = parseTableModel(lines);
    expect(m.header).toEqual(['商品', '個数', '状態']);
    expect(m.aligns).toEqual([null, 'right', 'center']);
    expect(m.rows).toEqual([
      ['りんご', '12', '在庫'],
      ['みかん', '3', '補充中'],
    ]);
  });

  it('直列化で標準 Markdown テーブル (ヘッダ + 区切り + データ) を復元する', () => {
    const s = serializeTableModel(parseTableModel(lines));
    expect(s.split('\n')).toEqual([
      '| 商品 | 個数 | 状態 |',
      '| --- | ---: | :---: |',
      '| りんご | 12 | 在庫 |',
      '| みかん | 3 | 補充中 |',
    ]);
  });

  it('列数の足りない行は空セルで埋める (GFM 準拠)', () => {
    const m = parseTableModel(['| a | b | c |', '| --- | --- | --- |', '| x |']);
    expect(m.rows).toEqual([['x', '', '']]);
  });

  it('パイプを含むセルはエスケープを往復しても標準 Markdown のまま', () => {
    const src = ['| 式 | 説明 |', '| --- | --- |', '| a \\| b | 論理和 |'];
    const m = parseTableModel(src);
    expect(m.rows[0]?.[0]).toBe('a | b'); // 編集用は非エスケープ
    expect(serializeTableModel(m).split('\n')[2]).toBe('| a \\| b | 論理和 |');
  });

  it('空セルは |  |  |  | 形式 (二重空白) で出力する', () => {
    const m = parseTableModel(['| a | b | c |', '| --- | --- | --- |', '|  |  |  |']);
    expect(serializeTableModel(m).split('\n')[2]).toBe('|  |  |  |');
  });
});

describe('行/列の追加・削除', () => {
  const base = (): ReturnType<typeof parseTableModel> =>
    parseTableModel(['| a | b |', '| --- | --- |', '| 1 | 2 |']);

  it('addRow は末尾に空データ行を足す', () => {
    const m = base();
    addRow(m);
    expect(m.rows).toEqual([['1', '2'], ['', '']]);
    expect(serializeTableModel(m).split('\n')).toEqual([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '|  |  |',
    ]);
  });

  it('addColumn はヘッダ・区切り・全行へ空列を足す', () => {
    const m = base();
    addColumn(m);
    expect(m.header).toEqual(['a', 'b', '']);
    expect(m.aligns).toEqual([null, null, null]);
    expect(m.rows).toEqual([['1', '2', '']]);
    expect(serializeTableModel(m).split('\n')).toEqual([
      '| a | b |  |',
      '| --- | --- | --- |',
      '| 1 | 2 |  |',
    ]);
  });

  it('deleteRow は指定位置のデータ行を除く', () => {
    const m = parseTableModel(['| a |', '| --- |', '| 1 |', '| 2 |']);
    deleteRow(m, 0);
    expect(m.rows).toEqual([['2']]);
  });

  it('deleteColumn は指定列を全行から除く', () => {
    const m = base();
    deleteColumn(m, 0);
    expect(m.header).toEqual(['b']);
    expect(m.rows).toEqual([['2']]);
  });

  it('deleteColumn は最後の 1 列を残す (空テーブル化しない)', () => {
    const m = parseTableModel(['| a |', '| --- |', '| 1 |']);
    deleteColumn(m, 0);
    expect(m.header).toEqual(['a']);
  });
});
