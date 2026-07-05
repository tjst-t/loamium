/**
 * GFM テーブルのセル分解 (splitTableRow) のユニットテスト (S79c210-2)。
 * Markdown パーサー相当のため必須 (DESIGN_PRINCIPLES coding_conventions)。
 * DOM 描画 (renderMarkdownTable) は table-render.mock/e2e.spec.ts で検証する。
 */
import { describe, expect, it } from 'vitest';
import { splitTableRow } from '../../src/renderers/table';

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
