/**
 * S2e8a4c-6 — toggleBold の純粋ロジック ユニットテスト (AC-S2e8a4c-6-5)。
 *
 * EditorView (DOM 必要) を使わず、applyBoldToggle 純粋関数で 4 ケースを検証する:
 * 1. 選択あり + 未Bold → Bold 化
 * 2. 選択あり + 既に Bold → UnBold
 * 3. 選択なし → **** 挿入、カーソル内側
 * 4. 純 Markdown 確認 (HTML タグなし)
 */
import { describe, expect, it } from 'vitest';
import { applyBoldToggle, isBoldText } from '../../src/bold-toggle.js';

describe('isBoldText', () => {
  it('** で囲まれていれば true', () => {
    expect(isBoldText('**Hello**')).toBe(true);
    expect(isBoldText('**太字テキスト**')).toBe(true);
  });
  it('** がなければ false', () => {
    expect(isBoldText('Hello')).toBe(false);
    expect(isBoldText('*Hello*')).toBe(false);
  });
  it('片方だけ ** でも false', () => {
    expect(isBoldText('**Hello')).toBe(false);
    expect(isBoldText('Hello**')).toBe(false);
  });
  it('最小 5 文字 (**x**) 未満は false', () => {
    expect(isBoldText('****')).toBe(false); // 4 文字
  });
});

describe('applyBoldToggle', () => {
  it('[AC-S2e8a4c-6-5] 選択あり + 未Bold → ** で囲んで Bold 化する', () => {
    const result = applyBoldToggle('Hello World', 6, 11); // 'World'
    expect(result.doc).toBe('Hello **World**');
    expect(result.selection).toEqual([6, 15]);
  });

  it('[AC-S2e8a4c-6-5] 選択あり + 既に Bold → ** を除去して UnBold する', () => {
    const result = applyBoldToggle('Hello **World** End', 6, 15); // '**World**'
    expect(result.doc).toBe('Hello World End');
    expect(result.selection).toEqual([6, 11]);
  });

  it('[AC-S2e8a4c-6-5] 選択なし (anchor == head) → **** を挿入してカーソルを内側に移動する', () => {
    const result = applyBoldToggle('Hello ', 6, 6);
    expect(result.doc).toBe('Hello ****');
    expect(result.selection).toEqual([8, 8]);
  });

  it('[AC-S2e8a4c-6-5] ピュア Markdown のみ書き込む (** のみ、HTML タグなし)', () => {
    const result = applyBoldToggle('text', 0, 4);
    expect(result.doc).toBe('**text**');
    expect(result.doc).not.toContain('<strong>');
    expect(result.doc).not.toContain('<b>');
  });

  it('日本語テキストも Bold 化できる', () => {
    const result = applyBoldToggle('こんにちは世界', 5, 7); // '世界'
    expect(result.doc).toBe('こんにちは**世界**');
  });

  it('選択が逆順 (head < anchor) でも正しく動作する', () => {
    const result = applyBoldToggle('Hello World', 11, 6); // head < anchor
    expect(result.doc).toBe('Hello **World**');
  });
});
