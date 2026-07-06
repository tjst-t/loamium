/**
 * 意味型システム (D方式) のユニットテスト (S87f4b7-2)。
 *
 * shared のパーサー系はテスト必須 (DESIGN_PRINCIPLES coding_conventions)。
 * 中核の保証:
 *  - ヒューリスティック解決がキー名 / 値の形から正しい意味型を返す
 *  - .loamium/property-types.json が JSON定義でヒューリスティックを上書きする
 *  - 壊れた JSON でもクラッシュせず、妥当なエントリのみ採用してフォールバックする
 *  - 型ピッカーの候補生成・絞り込みが内蔵型 + JSON定義型を混在提示する
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TYPE_META,
  buildTypePickerOptions,
  clampProgress,
  clampStar,
  defaultValueForType,
  filterTypeOptions,
  heuristicType,
  parsePropertyTypesJson,
  resolvePropertyType,
  selectColorFor,
} from './property-types.js';

describe('heuristicType', () => {
  it('キー名から意味型を推定する', () => {
    expect(heuristicType('rating', 4)).toBe('star');
    expect(heuristicType('score', 3)).toBe('star');
    expect(heuristicType('status', '進行中')).toBe('select');
    expect(heuristicType('state', 'open')).toBe('select');
    expect(heuristicType('created', '2026-05-20')).toBe('date');
    expect(heuristicType('updated', null)).toBe('date');
    expect(heuristicType('due', '')).toBe('date');
    expect(heuristicType('progress', 80)).toBe('progress');
    expect(heuristicType('percent', 50)).toBe('progress');
    expect(heuristicType('tags', ['a', 'b'])).toBe('tags');
    expect(heuristicType('aliases', [])).toBe('tags');
  });

  it('値の形から意味型を推定する (キー名が中立のとき)', () => {
    expect(heuristicType('flag', true)).toBe('checkbox');
    expect(heuristicType('flag', false)).toBe('checkbox');
    expect(heuristicType('参考', 'https://example.com/x')).toBe('url');
    expect(heuristicType('関連', '[[失敗学入門]]')).toBe('note-link');
    expect(heuristicType('日付ぽい', '2026-01-02')).toBe('date');
    expect(heuristicType('ページ数', 336)).toBe('number');
    expect(heuristicType('著者', 'マシュー・サイド')).toBe('text');
    expect(heuristicType('items', ['x'])).toBe('tags');
  });

  it('キー名照合は NFC + lowercase (大文字・全角無関係)', () => {
    expect(heuristicType('Rating', 5)).toBe('star');
    expect(heuristicType('STATUS', 'x')).toBe('select');
  });
});

describe('parsePropertyTypesJson', () => {
  it('妥当な定義を検証して採用する (options は string / {value,color} 混在可)', () => {
    const defs = parsePropertyTypesJson({
      優先度: {
        type: 'select',
        options: [
          { value: '高', color: 'red' },
          { value: '中', color: 'amber' },
          '低',
        ],
      },
      難易度: { type: 'star' },
    });
    expect(defs['優先度']?.type).toBe('select');
    expect(defs['優先度']?.options).toEqual([
      { value: '高', color: 'red' },
      { value: '中', color: 'amber' },
      { value: '低' },
    ]);
    expect(defs['難易度']).toEqual({ type: 'star' });
  });

  it('壊れたエントリは黙って捨て、妥当なものだけ残す (クラッシュしない — AC-2-3)', () => {
    const defs = parsePropertyTypesJson({
      良い: { type: 'progress' },
      不明な型: { type: 'rainbow' },
      色が変: { type: 'select', options: [{ value: 'a', color: 'octarine' }] },
      型なし: { note: 'oops' },
    });
    expect(Object.keys(defs)).toEqual(['良い']);
    expect(defs['良い']).toEqual({ type: 'progress' });
  });

  it('オブジェクトでない入力は {} (フォールバック)', () => {
    expect(parsePropertyTypesJson(null)).toEqual({});
    expect(parsePropertyTypesJson('broken')).toEqual({});
    expect(parsePropertyTypesJson([1, 2, 3])).toEqual({});
    expect(parsePropertyTypesJson(42)).toEqual({});
  });
});

describe('resolvePropertyType', () => {
  it('JSON定義があればヒューリスティックを上書きする (source=json)', () => {
    const defs = parsePropertyTypesJson({
      status: { type: 'text' },
      優先度: { type: 'select', options: ['高', '低'] },
    });
    // status は本来 select だが JSON定義 text で上書き
    expect(resolvePropertyType('status', 'x', defs)).toEqual({ type: 'text', source: 'json' });
    // JSON定義キーは options 付きで解決
    expect(resolvePropertyType('優先度', '高', defs)).toEqual({
      type: 'select',
      source: 'json',
      options: [{ value: '高' }, { value: '低' }],
    });
  });

  it('JSON定義が無ければヒューリスティック (source=builtin)', () => {
    expect(resolvePropertyType('rating', 4, {})).toEqual({ type: 'star', source: 'builtin' });
    expect(resolvePropertyType('著者', 'X', {})).toEqual({ type: 'text', source: 'builtin' });
  });
});

describe('buildTypePickerOptions / filterTypeOptions', () => {
  it('内蔵型 + JSON定義型を混在提示する (JSON定義は source=json)', () => {
    const defs = parsePropertyTypesJson({
      優先度: { type: 'select', options: ['高', '中', '低'] },
      難易度: { type: 'star' },
    });
    const { builtin, json } = buildTypePickerOptions(defs);
    expect(builtin.map((o) => o.name)).toEqual(BUILTIN_TYPE_META.map((m) => m.type));
    expect(builtin.every((o) => o.source === 'builtin')).toBe(true);
    expect(json.map((o) => o.name)).toEqual(['優先度', '難易度']);
    expect(json.every((o) => o.source === 'json')).toBe(true);
    expect(json[0]?.desc).toBe('select: 高 / 中 / 低');
  });

  it("インクリメンタル絞り込み: 's' で select/star/... に絞れる (AC-3-1)", () => {
    const { builtin } = buildTypePickerOptions({});
    const hits = filterTypeOptions(builtin, 's').map((o) => o.name);
    expect(hits).toContain('select');
    expect(hits).toContain('star');
    expect(hits).not.toContain('date');
    // さらに打つと絞られる
    expect(filterTypeOptions(builtin, 'star').map((o) => o.name)).toEqual(['star']);
  });

  it('JSON定義型もキー名で絞り込める', () => {
    const defs = parsePropertyTypesJson({ 優先度: { type: 'select' } });
    const { json } = buildTypePickerOptions(defs);
    expect(filterTypeOptions(json, '優先').map((o) => o.name)).toEqual(['優先度']);
    expect(filterTypeOptions(json, 'zzz')).toEqual([]);
  });
});

describe('値の正規化ヘルパ', () => {
  it('defaultValueForType は型に応じた標準 YAML スカラーを返す', () => {
    expect(defaultValueForType('star')).toBe(0);
    expect(defaultValueForType('number')).toBe(0);
    expect(defaultValueForType('progress')).toBe(0);
    expect(defaultValueForType('checkbox')).toBe(false);
    expect(defaultValueForType('tags')).toEqual([]);
    expect(defaultValueForType('multi-select')).toEqual([]);
    expect(defaultValueForType('select')).toBe('');
    expect(defaultValueForType('text')).toBe('');
  });

  it('clampStar / clampProgress は範囲内の整数へ丸める', () => {
    expect(clampStar(4)).toBe(4);
    expect(clampStar(9)).toBe(5);
    expect(clampStar(-1)).toBe(0);
    expect(clampStar(3.6)).toBe(4);
    expect(clampProgress(80)).toBe(80);
    expect(clampProgress(150)).toBe(100);
    expect(clampProgress(-5)).toBe(0);
  });

  it('selectColorFor は options の色を優先し、無ければ安定に割り当てる', () => {
    expect(selectColorFor('高', [{ value: '高', color: 'red' }])).toBe('red');
    const a = selectColorFor('読了');
    const b = selectColorFor('読了');
    expect(a).toBe(b); // 同じ値は同じ色 (安定)
  });
});
