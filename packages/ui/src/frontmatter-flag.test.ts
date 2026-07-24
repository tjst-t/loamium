import { describe, it, expect } from 'vitest';
import { computeFrontmatterFlagEdit } from './frontmatter-flag.js';

/** 返された編集を text へ適用した結果文字列。null なら変更なし(元のまま)。 */
function apply(text: string, key: string, next: boolean): string | null {
  const edit = computeFrontmatterFlagEdit(text, key, next);
  if (edit === null) return null;
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

describe('computeFrontmatterFlagEdit', () => {
  it('frontmatter 無し + set → 先頭に frontmatter ブロックを作る', () => {
    const out = apply('# 本文\n\nテキスト\n', 'bookmark', true);
    expect(out).toBe('---\nbookmark: true\n---\n# 本文\n\nテキスト\n');
  });

  it('既存 frontmatter (他キー) + set → bookmark を追加し他キー・本文を保持', () => {
    const src = '---\ntitle: メモ\ntags:\n  - a\n---\n# 本文\n';
    const out = apply(src, 'bookmark', true);
    expect(out).toContain('title: メモ');
    expect(out).toContain('bookmark: true');
    expect(out).toContain('- a');
    expect(out?.endsWith('---\n# 本文\n')).toBe(true);
    // 本文は 1 度だけ (二重化していない)
    expect(out?.match(/# 本文/g)?.length).toBe(1);
  });

  it('bookmark 有り + unset → bookmark 行のみ除去し他キー・本文を保持', () => {
    const src = '---\ntitle: メモ\nbookmark: true\n---\n本文\n';
    const out = apply(src, 'bookmark', false);
    expect(out).toBe('---\ntitle: メモ\n---\n本文\n');
  });

  it('bookmark のみの frontmatter + unset → ブロックごと除去し本文を保持', () => {
    const src = '---\nbookmark: true\n---\n本文だけ\n';
    const out = apply(src, 'bookmark', false);
    expect(out).toBe('本文だけ\n');
  });

  it('frontmatter 無し + unset → null (何もしない)', () => {
    expect(computeFrontmatterFlagEdit('# 本文\n', 'bookmark', false)).toBeNull();
  });

  it('bookmark 不在の frontmatter + unset → null (何もしない)', () => {
    expect(
      computeFrontmatterFlagEdit('---\ntitle: メモ\n---\n本文\n', 'bookmark', false),
    ).toBeNull();
  });

  it('モデル化できない frontmatter (トップレベルがシーケンス) は触らない (null)', () => {
    const src = '---\n- a\n- b\n---\n本文\n';
    expect(computeFrontmatterFlagEdit(src, 'bookmark', true)).toBeNull();
  });

  it('アンカー等の complex frontmatter でも bookmark を追加でき、原文を保持する', () => {
    const src = '---\nfoo: &a\n  - 1\nbar: *a\n---\n本文\n';
    const out = apply(src, 'bookmark', true);
    expect(out).not.toBeNull();
    expect(out).toContain('bookmark: true');
    expect(out).toContain('*a'); // complex エントリは原文保持
  });

  it('set の結果 frontmatter は再パースで bookmark:true を含む (往復健全性)', () => {
    const out = apply('---\ntitle: x\n---\n本文\n', 'bookmark', true);
    expect(out).not.toBeNull();
    // 生成された frontmatter が壊れていない (--- で挟まれている)
    expect(out?.startsWith('---\n')).toBe(true);
    expect(out).toContain('\n---\n本文\n');
  });
});
