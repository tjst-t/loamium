/**
 * embed の純粋ロジック (循環検出・深さ制限・ターゲット解釈・拡張子ディスパッチ) の
 * ユニットテスト (Task S9e5ca4-1-2: ユニットテスト必須)。
 * DOM を要する描画は Playwright (embed.mock/e2e.spec.ts) 側で検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  checkEmbedChain,
  embedExtensionOf,
  getEmbedFileRenderer,
  IMAGE_EXTENSIONS,
  MAX_EMBED_DEPTH,
  parseEmbedTarget,
  registerEmbedFileRenderer,
} from '../../src/renderers/embed';

describe('parseEmbedTarget', () => {
  it('![[note]] はターゲットのみ', () => {
    expect(parseEmbedTarget('自宅サーバー構成')).toEqual({ target: '自宅サーバー構成', section: null });
  });

  it('![[note#見出し]] はセクション付き (trim + NFC)', () => {
    expect(parseEmbedTarget(' バックリンク実装方針 # インデックス更新 ')).toEqual({
      target: 'バックリンク実装方針',
      section: 'インデックス更新',
    });
    const nfd = 'ガ'.normalize('NFD');
    expect(parseEmbedTarget(`${nfd}行`).target).toBe('ガ行');
  });

  it('^block 参照は見出しセクションとして扱わない (読み取り互換のみ)', () => {
    expect(parseEmbedTarget('note#^abc123')).toEqual({ target: 'note', section: null });
  });
});

describe('checkEmbedChain (AC-S9e5ca4-1-3 の判定ロジック)', () => {
  it('未訪問かつ深さ内なら ok', () => {
    expect(checkEmbedChain(['a.md'], 'b.md')).toEqual({ ok: true });
  });

  it('再訪 (A→B→A) は cycle として打ち切る', () => {
    const r = checkEmbedChain(['a.md', 'b.md'], 'a.md');
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toBe('cycle');
      expect(r.chain).toEqual(['a.md', 'b.md', 'a.md']);
    }
  });

  it('自己埋め込み (A→A) も cycle', () => {
    const r = checkEmbedChain(['a.md'], 'a.md');
    expect(r.ok === false && r.reason === 'cycle').toBe(true);
  });

  it(`チェーンが最大深さ ${String(MAX_EMBED_DEPTH)} に達したら depth で打ち切る`, () => {
    const chain = Array.from({ length: MAX_EMBED_DEPTH }, (_, i) => `n${String(i)}.md`);
    const r = checkEmbedChain(chain, 'next.md');
    expect(r.ok === false && r.reason === 'depth').toBe(true);
    // 深さ未満なら通る (境界の 1 つ手前)
    expect(checkEmbedChain(chain.slice(0, MAX_EMBED_DEPTH - 1), 'next.md')).toEqual({ ok: true });
  });
});

describe('embedExtensionOf + 拡張子ディスパッチのレジストリ', () => {
  it('.md と拡張子なしは null (ノート embed)', () => {
    expect(embedExtensionOf('note.md')).toBeNull();
    expect(embedExtensionOf('projects/メモ')).toBeNull();
    expect(embedExtensionOf('.hidden')).toBeNull();
  });

  it('画像などの拡張子を小文字で返す', () => {
    expect(embedExtensionOf('assets/rack.PNG')).toBe('png');
    expect(embedExtensionOf('a/b/c.svg')).toBe('svg');
  });

  it('画像拡張子は既定でレンダラー登録される (registerBuiltinRenderers 経由)', async () => {
    const { registerBuiltinRenderers } = await import('../../src/renderers/index');
    registerBuiltinRenderers();
    for (const ext of IMAGE_EXTENSIONS) {
      expect(getEmbedFileRenderer(ext), ext).toBeDefined();
    }
  });

  it('新しいファイル種別はレジストリ登録だけで追加できる (エンジンと同じ lookup 経路)', () => {
    expect(getEmbedFileRenderer('pdf-test')).toBeUndefined();
    const renderer = {
      extensions: ['pdf-test'],
      render: () => {
        throw new Error('not called in this test');
      },
    };
    registerEmbedFileRenderer(renderer);
    expect(getEmbedFileRenderer('pdf-test')).toBe(renderer);
    expect(getEmbedFileRenderer('PDF-TEST')).toBe(renderer); // 大文字小文字不区別
  });
});
