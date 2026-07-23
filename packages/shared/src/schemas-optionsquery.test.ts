/**
 * S1bd397-1 スキーマ加算の後方互換ユニットテスト。
 *
 * optionsQuery を追加しても既存テンプレート/コマンド定義・テストが壊れないことを検証。
 * test-discipline Rule 1: 各 it は 1 AC を被覆。
 */
import { describe, expect, it } from 'vitest';
import { templateVarSchema, type TemplateVar } from './schemas.js';
import { commandParamSchema, type CommandParam } from './loamium-command.js';

// ---- AC-S1bd397-1-1: 後方互換 (optionsQuery 省略=現状挙動) ----

describe('[AC-S1bd397-1-1] templateVarSchema 後方互換', () => {
  it('optionsQuery なしの既存 TemplateVar は変化なし (text)', () => {
    const raw = { name: '会議名', type: 'text', required: true };
    const parsed = templateVarSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.optionsQuery).toBeUndefined();
      expect(parsed.data.name).toBe('会議名');
    }
  });

  it('optionsQuery なしの既存 TemplateVar は変化なし (select + options)', () => {
    const raw = { name: 'カテゴリ', type: 'select', required: false, options: ['定例', '臨時'] };
    const parsed = templateVarSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.options).toEqual(['定例', '臨時']);
      expect(parsed.data.optionsQuery).toBeUndefined();
    }
  });

  it('optionsQuery なしの既存 TemplateVar は変化なし (date)', () => {
    const raw = { name: '日付', type: 'date', required: false, default: '{{date:YYYY-MM-DD}}' };
    const parsed = templateVarSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('optionsQuery なしの既存 TemplateVar は変化なし (tags)', () => {
    const raw = { name: '参加者', type: 'tags', required: false };
    const parsed = templateVarSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('select + optionsQuery で options 省略可 (optionsQuery が候補を提供)', () => {
    const raw: unknown = {
      name: 'プロジェクト名',
      type: 'select',
      required: true,
      optionsQuery: 'LIST FROM #project',
    };
    const parsed = templateVarSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.optionsQuery).toBe('LIST FROM #project');
    }
  });

  it('text + optionsQuery でオートコンプリート定義', () => {
    const raw: unknown = {
      name: 'プロジェクト名',
      type: 'text',
      required: true,
      optionsQuery: 'LIST FROM #project',
    };
    const parsed = templateVarSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const v = parsed.data as TemplateVar;
      expect(v.optionsQuery).toBe('LIST FROM #project');
    }
  });
});

// ---- AC-S1bd397-1-1: CommandParam 後方互換 ----

describe('[AC-S1bd397-1-1] commandParamSchema 後方互換', () => {
  it('optionsQuery なしの既存 CommandParam は変化なし (string)', () => {
    const raw = { name: 'タスク', type: 'string', required: true };
    const parsed = commandParamSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.optionsQuery).toBeUndefined();
    }
  });

  it('optionsQuery なしの既存 CommandParam は変化なし (select + options)', () => {
    const raw = { name: '優先度', type: 'select', required: false, options: ['高', '中', '低'] };
    const parsed = commandParamSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.options).toEqual(['高', '中', '低']);
      expect(parsed.data.optionsQuery).toBeUndefined();
    }
  });

  it('select + optionsQuery で options 省略可', () => {
    const raw: unknown = {
      name: 'プロジェクト',
      type: 'select',
      required: true,
      optionsQuery: 'LIST FROM #project',
    };
    const parsed = commandParamSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const p = parsed.data as CommandParam;
      expect(p.optionsQuery).toBe('LIST FROM #project');
    }
  });

  it('note + optionsQuery で絞り込みノートピッカー定義', () => {
    const raw: unknown = {
      name: 'ターゲット',
      type: 'note',
      required: true,
      optionsQuery: 'LIST FROM #project WHERE status = "open"',
    };
    const parsed = commandParamSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const p = parsed.data as CommandParam;
      expect(p.optionsQuery).toBe('LIST FROM #project WHERE status = "open"');
    }
  });

  it('select + options なし + optionsQuery なし は依然エラー (既存の required: options 検証)', () => {
    const raw = { name: '優先度', type: 'select', required: false };
    const parsed = commandParamSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
  });
});
