/**
 * Story 4 — GFM テーブルレンダリング / splitCodeRegions のユニットテスト。
 *
 * renderChatMarkdown (Markdown → HTML) は DOMPurify (ブラウザ API) を使うため
 * vi.mock でパススルー化する。テストの焦点は:
 *   1. splitCodeRegions の join('') 修正により GFM テーブル行間に二重改行が
 *      生じないこと (旧バグ: join('\n') により \n\n が挿入されテーブルが段落化した)。
 *   2. renderChatMarkdown が GFM テーブル Markdown を <table>/<td> を含む HTML に変換すること。
 *   3. コード領域内の [[リンク]] は置換されないこと (既存挙動の保護)。
 */
import { describe, expect, it, vi } from 'vitest';

// DOMPurify はブラウザ DOM API が必要。Vitest (Node.js) 環境ではパススルーにモックする。
vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

import {
  splitCodeRegions,
  renderChatMarkdown,
} from '../../src/components/AgentPane.js';

// ---------------------------------------------------------------------------
// splitCodeRegions
// ---------------------------------------------------------------------------
describe('splitCodeRegions', () => {
  it('テーブル行間に二重改行が入らない (join 修正の回帰テスト)', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const segments = splitCodeRegions(md);
    // 非コードセグメントが 1 つで、元文字列と等しい (二重改行なし)
    expect(segments).toHaveLength(1);
    expect(segments[0]?.code).toBe(false);
    expect(segments[0]?.value).toBe(md);
  });

  it('フェンスコード前後の非コード部分もテーブル行間が正常', () => {
    const md = 'before\n```\ncode\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    const segments = splitCodeRegions(md);
    // 2 セグメント: 非コード('before\n') + コード('```\ncode\n```\n') + 非コード(テーブル)
    // 最後の非コードセグメントを確認
    const nonCode = segments.filter((s) => !s.code);
    const table = nonCode.find((s) => s.value.includes('|'));
    expect(table?.value).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('コード内の [[リンク]] は非コード分割から保護される', () => {
    const md = '```\n[[note]]\n```';
    const segments = splitCodeRegions(md);
    const codeSegs = segments.filter((s) => s.code);
    expect(codeSegs.some((s) => s.value.includes('[[note]]'))).toBe(true);
    const nonCodeSegs = segments.filter((s) => !s.code);
    expect(nonCodeSegs.every((s) => !s.value.includes('[[note]]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderChatMarkdown: GFM テーブルが <table>/<td> に変換される
// ---------------------------------------------------------------------------
describe('renderChatMarkdown — GFM テーブル', () => {
  const emptyPaths = new Set<string>();

  it('GFM テーブルが <table> 要素に変換される', () => {
    const md = '| 名前 | 値 |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |';
    const html = renderChatMarkdown(md, emptyPaths);
    expect(html).toContain('<table');
    expect(html).toContain('<thead');
    expect(html).toContain('<tbody');
    expect(html).toContain('<td>');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
  });

  it('テーブルの前後にテキストがあっても <table> が生成される', () => {
    const md = '以下の通りです。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n以上です。';
    const html = renderChatMarkdown(md, emptyPaths);
    expect(html).toContain('<table');
    expect(html).toContain('<td>');
  });

  it('テーブルの後ろにコードブロックがあっても双方が正しく変換される', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconsole.log("hi")\n```';
    const html = renderChatMarkdown(md, emptyPaths);
    expect(html).toContain('<table');
    expect(html).toContain('<pre>');
    expect(html).toContain('console.log');
  });

  it('コード内の [[リンク]] はアンカーに変換されない', () => {
    const md = '```\n[[note]]\n```';
    const html = renderChatMarkdown(md, emptyPaths);
    expect(html).not.toContain('agent-wikilink');
    expect(html).toContain('[[note]]');
  });

  it('存在するノートへの [[リンク]] は <a data-wl-target> に変換される', () => {
    const paths = new Set(['design.md']);
    const md = '[[design]] を参照してください。';
    const html = renderChatMarkdown(md, paths);
    expect(html).toContain('data-wl-target="design.md"');
    expect(html).toContain('agent-wikilink');
  });
});
