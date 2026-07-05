/**
 * frontmatter プロパティモデルのユニットテスト (S9df823-1)。
 *
 * 中核の保証: 「モデルへ分解 → 編集 → 直列化」した結果を parseNote (と同じ
 * yaml パーサー) で読み戻すと期待どおりの値になる (round-trip)。
 * Markdown パーサー相当のため必須 (DESIGN_PRINCIPLES coding_conventions)。
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseNote } from './markdown.js';
import {
  hasKeyedProperties,
  isDateLike,
  parsePropInput,
  parsePropertiesModel,
  serializeFrontmatterBlock,
  serializeProperties,
  type PropEntry,
} from './frontmatter.js';

/** 直列化結果を yaml で読み戻す (round-trip 検証用)。 */
function roundTrip(entries: PropEntry[]): unknown {
  return parseYaml(serializeProperties(entries));
}

describe('parsePropertiesModel', () => {
  it('スカラーとフラット配列を編集可能エントリへ分解する', () => {
    const model = parsePropertiesModel(
      ['tags: [sample-project, infra]', 'status: 進行中', 'priority: 1', 'done: false', 'created: 2026-06-01'].join(
        '\n',
      ),
    );
    expect(model).not.toBeNull();
    expect(model).toEqual([
      { kind: 'list', key: 'tags', items: ['sample-project', 'infra'], source: ['tags: [sample-project, infra]'] },
      { kind: 'scalar', key: 'status', value: '進行中', source: ['status: 進行中'] },
      { kind: 'scalar', key: 'priority', value: 1, source: ['priority: 1'] },
      { kind: 'scalar', key: 'done', value: false, source: ['done: false'] },
      { kind: 'scalar', key: 'created', value: '2026-06-01', source: ['created: 2026-06-01'] },
    ]);
  });

  it('ブロックシーケンス (Obsidian 形式の tags) も list になる', () => {
    const model = parsePropertiesModel('tags:\n  - a\n  - b');
    expect(model).toEqual([{ kind: 'list', key: 'tags', items: ['a', 'b'], source: ['tags:', '  - a', '  - b'] }]);
  });

  it('ネストしたオブジェクトは complex (読み取り専用) になり原文を保持する', () => {
    const src = 'title: メモ\nmeta:\n  author: tjst\n  depth: 2';
    const model = parsePropertiesModel(src);
    expect(model).not.toBeNull();
    expect(model?.[1]).toEqual({
      kind: 'complex',
      key: 'meta',
      source: ['meta:', '  author: tjst', '  depth: 2'],
    });
    // complex を含んだまま直列化しても原文が verbatim で残る
    expect(serializeProperties(model ?? [])).toBe(`${src}\n`);
  });

  it('複数行文字列 (block scalar) は complex になる', () => {
    const model = parsePropertiesModel('desc: |\n  line1\n  line2');
    expect(model?.[0]?.kind).toBe('complex');
  });

  it('null 値はスカラー (空値) として編集可能', () => {
    const model = parsePropertiesModel('status:');
    expect(model).toEqual([{ kind: 'scalar', key: 'status', value: null, source: ['status:'] }]);
  });

  it('トップレベルのコメント行と空行は raw として保持される', () => {
    const src = '# コメント\ntags: [a]\n\nstatus: x';
    const model = parsePropertiesModel(src);
    expect(model?.map((e) => e.kind)).toEqual(['raw', 'list', 'raw', 'scalar']);
    expect(serializeProperties(model ?? [])).toBe(`${src}\n`);
  });

  it('壊れた YAML / 非オブジェクト / 空テキストは null', () => {
    expect(parsePropertiesModel('title: [')).toBeNull();
    expect(parsePropertiesModel('- a\n- b')).toBeNull();
    expect(parsePropertiesModel('just a scalar')).toBeNull();
    expect(parsePropertiesModel('')).toBeNull();
  });

  it('引用符付きキーは complex になり原文を保持する', () => {
    const model = parsePropertiesModel('"a:b": 1\nplain: 2');
    expect(model?.[0]).toEqual({ kind: 'complex', key: 'a:b', source: ['"a:b": 1'] });
    expect(model?.[1]?.kind).toBe('scalar');
  });
});

describe('serializeProperties — round-trip 保証', () => {
  it('未編集エントリは原文バイトを一切変えない (flow 配列のスタイル維持)', () => {
    const src = 'tags: [sample-project, infra]\nstatus: 進行中\npriority: 1';
    const model = parsePropertiesModel(src);
    expect(serializeProperties(model ?? [])).toBe(`${src}\n`);
  });

  it('編集済みスカラー (source 除去) は標準 YAML になり、読み戻すと同値', () => {
    const entries: PropEntry[] = [
      { kind: 'scalar', key: 'status', value: '完了' },
      { kind: 'scalar', key: 'priority', value: 2 },
      { kind: 'scalar', key: 'done', value: true },
      { kind: 'scalar', key: 'empty', value: null },
    ];
    const text = serializeProperties(entries);
    expect(text).toBe('status: 完了\npriority: 2\ndone: true\nempty:\n');
    expect(roundTrip(entries)).toEqual({ status: '完了', priority: 2, done: true, empty: null });
  });

  it('クオートが必要な文字列 (: や # を含む・型と紛らわしい) を正しく引用する', () => {
    const entries: PropEntry[] = [
      { kind: 'scalar', key: 'a', value: 'x: y' },
      { kind: 'scalar', key: 'b', value: '#tag' },
      { kind: 'scalar', key: 'c', value: 'true' },
      { kind: 'scalar', key: 'd', value: '5' },
      { kind: 'scalar', key: 'e', value: '- listish' },
      { kind: 'scalar', key: 'f', value: '' },
    ];
    expect(roundTrip(entries)).toEqual({
      a: 'x: y',
      b: '#tag',
      c: 'true',
      d: '5',
      e: '- listish',
      f: '',
    });
  });

  it('編集済み配列はブロックシーケンス (Obsidian 形式) になり、読み戻すと同値', () => {
    const entries: PropEntry[] = [{ kind: 'list', key: 'tags', items: ['a b', 'c: d', '日本語'] }];
    const text = serializeProperties(entries);
    expect(text).toBe('tags:\n  - a b\n  - "c: d"\n  - 日本語\n');
    expect(roundTrip(entries)).toEqual({ tags: ['a b', 'c: d', '日本語'] });
  });

  it('空配列は tags: [] へ直列化される', () => {
    expect(serializeProperties([{ kind: 'list', key: 'tags', items: [] }])).toBe('tags: []\n');
  });

  it('日本語キー・日本語値も round-trip する', () => {
    const entries: PropEntry[] = [
      { kind: 'scalar', key: '状態', value: '進行中' },
      { kind: 'list', key: 'タグ', items: ['メモ', '開発'] },
    ];
    expect(roundTrip(entries)).toEqual({ 状態: '進行中', タグ: ['メモ', '開発'] });
  });

  it('直列化結果に制御文字 (NUL 等) が混入しない', () => {
    const entries: PropEntry[] = [
      { kind: 'scalar', key: 'status', value: '完了' },
      { kind: 'list', key: 'tags', items: ['a'] },
    ];
    // eslint-disable-next-line no-control-regex
    expect(serializeProperties(entries)).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });
});

describe('serializeFrontmatterBlock + parseNote 整合', () => {
  it('ブロックへ直列化したものを parseNote で読むと frontmatter が同値になる', () => {
    const entries: PropEntry[] = [
      { kind: 'list', key: 'tags', items: ['sample', 'x'] },
      { kind: 'scalar', key: 'status', value: '進行中' },
      { kind: 'scalar', key: 'rating', value: 4.5 },
    ];
    const block = serializeFrontmatterBlock(entries);
    expect(block).not.toBeNull();
    const note = `${block ?? ''}\n\n# 本文\n`;
    const parsed = parseNote(note);
    expect(parsed.frontmatter).toEqual({ tags: ['sample', 'x'], status: '進行中', rating: 4.5 });
    expect(parsed.body).toBe('\n# 本文\n');
  });

  it('キー付きエントリが無ければ null (frontmatter ブロック除去)', () => {
    expect(serializeFrontmatterBlock([])).toBeNull();
    expect(serializeFrontmatterBlock([{ kind: 'raw', source: ['# comment'] }])).toBeNull();
    expect(hasKeyedProperties([{ kind: 'raw', source: [''] }])).toBe(false);
  });

  it('実サンプル相当の frontmatter を分解 → 一部編集 → parseNote で読み戻せる', () => {
    const src = 'tags: [sample-project, infra]\nstatus: 進行中\npriority: 1\ncreated: 2026-06-01';
    const model = parsePropertiesModel(src);
    expect(model).not.toBeNull();
    const edited = (model ?? []).map((e): PropEntry => {
      if (e.kind === 'scalar' && e.key === 'status') return { kind: 'scalar', key: 'status', value: '完了' };
      return e;
    });
    const block = serializeFrontmatterBlock(edited);
    const parsed = parseNote(`${block ?? ''}\n本文\n`);
    expect(parsed.frontmatter).toEqual({
      tags: ['sample-project', 'infra'],
      status: '完了',
      priority: 1,
      created: '2026-06-01',
    });
  });
});

describe('parsePropInput / isDateLike', () => {
  it('素朴な型解釈: 空→null / true・false→真偽 / 数値表記→数値 / 他→文字列', () => {
    expect(parsePropInput('')).toBeNull();
    expect(parsePropInput('  ')).toBeNull();
    expect(parsePropInput('true')).toBe(true);
    expect(parsePropInput('false')).toBe(false);
    expect(parsePropInput('42')).toBe(42);
    expect(parsePropInput('-1.5')).toBe(-1.5);
    expect(parsePropInput('2026-07-05')).toBe('2026-07-05');
    expect(parsePropInput(' 進行中 ')).toBe('進行中');
  });

  it('isDateLike は YYYY-MM-DD のみ true', () => {
    expect(isDateLike('2026-07-05')).toBe(true);
    expect(isDateLike('2026-7-5')).toBe(false);
    expect(isDateLike(20260705)).toBe(false);
    expect(isDateLike(null)).toBe(false);
  });
});
