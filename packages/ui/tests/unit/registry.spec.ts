/**
 * [AC-S9ab6c3-2-3] fence / inline / block の 3 レジストリのユニットテスト。
 *
 * レンダラーが 3 レジストリ経由で登録されること、および「新しい言語識別子を
 * レジストリ登録だけで追加できる」ことを、エディタ本体を介さず registry の
 * 公開 API (エンジンが使うのと同じ lookup 経路) で検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  getBlockRules,
  getFenceRenderer,
  getInlineRules,
  registerBlockRule,
  registerFenceRenderer,
  registerInlineRule,
  type BlockRule,
  type FenceRenderer,
  type InlineRule,
} from '../../src/registries';
import { registerBuiltinRenderers } from '../../src/renderers/index';

describe('[AC-S9ab6c3-2-3] fence レジストリ', () => {
  it('新しい言語識別子はレジストリ登録だけで追加できる (エンジンと同じ lookup 経路)', () => {
    // 登録前: 未知の識別子は解決されない → エディタはソース表示のまま
    expect(getFenceRenderer('graphviz-test')).toBeUndefined();

    const renderer: FenceRenderer = {
      lang: 'graphviz-test',
      kind: 'client',
      mode: 'replace',
      render: () => undefined,
    };
    registerFenceRenderer(renderer);

    // 登録後: コード変更なしで同じ lookup がレンダラーを返す
    expect(getFenceRenderer('graphviz-test')).toBe(renderer);
    expect(getFenceRenderer('graphviz-test')?.mode).toBe('replace');
    expect(getFenceRenderer('graphviz-test')?.kind).toBe('client');
  });

  it('複数言語識別子 (lang: string[]) を 1 レンダラーで登録できる', () => {
    const renderer: FenceRenderer = {
      lang: ['drawio-test', 'xml-drawio-test'],
      kind: 'client',
      mode: 'augment',
      render: () => undefined,
    };
    registerFenceRenderer(renderer);
    expect(getFenceRenderer('drawio-test')).toBe(renderer);
    expect(getFenceRenderer('xml-drawio-test')).toBe(renderer);
    expect(getFenceRenderer('drawio-test')?.mode).toBe('augment');
  });
});

describe('[AC-S9ab6c3-2-3] inline レジストリ', () => {
  it('registerInlineRule で登録したルールが getInlineRules に現れる', () => {
    const before = getInlineRules().length;
    const rule: InlineRule = {
      pattern: /==([^=\n]+)==/g,
      render: () => {
        throw new Error('unit テストでは呼ばれない');
      },
    };
    registerInlineRule(rule);
    const rules = getInlineRules();
    expect(rules.length).toBe(before + 1);
    expect(rules[rules.length - 1]).toBe(rule);
  });
});

describe('[AC-S9ab6c3-2-3] block レジストリ', () => {
  it('registerBlockRule で登録したルールが getBlockRules に現れ、match / matchEnd が機能する', () => {
    const before = getBlockRules().length;
    const rule: BlockRule = {
      match: (line) => line.startsWith(':::test'),
      matchEnd: (line, offset) => offset > 0 && line.trim() === ':::',
      render: () => {
        throw new Error('unit テストでは呼ばれない');
      },
    };
    registerBlockRule(rule);
    const rules = getBlockRules();
    expect(rules.length).toBe(before + 1);

    const added = rules[rules.length - 1];
    expect(added).toBe(rule);
    expect(added?.match(':::test callout')).toBe(true);
    expect(added?.match('plain paragraph')).toBe(false);
    expect(added?.matchEnd?.(':::', 2)).toBe(true);
    expect(added?.matchEnd?.(':::', 0)).toBe(false); // 開始行は終端にしない
  });
});

describe('[AC-S9ab6c3-2-3] ビルトインレンダラー (Mermaid + KaTeX + Shiki) は 3 レジストリ経由で登録される', () => {
  it('registerBuiltinRenderers で mermaid / コード言語 / 数式ルールが揃う', () => {
    registerBuiltinRenderers();

    // fence: mermaid (replace) と shiki (代表: bash / typescript)
    expect(getFenceRenderer('mermaid')?.kind).toBe('client');
    expect(getFenceRenderer('bash')).toBeDefined();
    expect(getFenceRenderer('typescript')).toBeDefined();
    // 未登録言語は undefined のまま (ソース表示にフォールバック)
    expect(getFenceRenderer('foolang-not-registered')).toBeUndefined();

    // inline: $…$ / block: $$…$$ (KaTeX)
    expect(getInlineRules().some((r) => r.pattern.test('$E=mc^2$'))).toBe(true);
    expect(getBlockRules().some((r) => r.match('$$'))).toBe(true);
  });
});
