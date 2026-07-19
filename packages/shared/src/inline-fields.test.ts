/**
 * インラインフィールドパーサーのユニットテスト (Se3b7a2-1 / ADR-0029)。
 *
 * [AC-Se3b7a2-1-4]
 */
import { describe, expect, it } from 'vitest';
import { extractInlineFields, setInlineField } from './inline-fields.js';

describe('extractInlineFields', () => {
  // ---- AC-Se3b7a2-1-4 (a): status + priority + due 付き行で全フィールド取得 ----

  it('status + priority + due が揃った行で全フィールドを返す', () => {
    const line = '- [ ] タスク [status:: progress] [priority:: high] [due:: 2026-07-25]';
    expect(extractInlineFields(line)).toEqual({
      status: 'progress',
      priority: 'high',
      due: '2026-07-25',
    });
  });

  it('フィールドの順番が異なっても正しく抽出する', () => {
    const line = '- [ ] タスク [due:: 2026-08-01] [priority:: low] [status:: blocked]';
    expect(extractInlineFields(line)).toEqual({
      status: 'blocked',
      priority: 'low',
      due: '2026-08-01',
    });
  });

  // ---- AC-Se3b7a2-1-4 (b): フィールドなし → すべて null ----

  it('インラインフィールドがない行はすべて null を返す', () => {
    expect(extractInlineFields('- [ ] シンプルなタスク')).toEqual({
      status: null,
      priority: null,
      due: null,
    });
  });

  it('空行はすべて null を返す', () => {
    expect(extractInlineFields('')).toEqual({
      status: null,
      priority: null,
      due: null,
    });
  });

  // ---- AC-Se3b7a2-1-4 (c): インラインコード内は無視 ----

  it('インラインコード内の [status:: done] は無視する', () => {
    const line = '- [ ] `[status:: done]` は無視 [priority:: high]';
    expect(extractInlineFields(line)).toEqual({
      status: null,
      priority: 'high',
      due: null,
    });
  });

  it('インラインコード内の [priority:: high] は無視する', () => {
    const line = 'use `[priority:: high]` for example [status:: todo]';
    expect(extractInlineFields(line)).toEqual({
      status: 'todo',
      priority: null,
      due: null,
    });
  });

  // ---- AC-Se3b7a2-1-4 (d): due 日付形式不正 → null ----

  it('due の形式が不正 (YYYY-MM-DD 以外) なら null を返す', () => {
    const line = '- [ ] タスク [due:: 2026/07/25]';
    expect(extractInlineFields(line)).toEqual({
      status: null,
      priority: null,
      due: null,
    });
  });

  it('due が "tomorrow" などの文字列なら null を返す', () => {
    const line = '- [ ] タスク [due:: tomorrow]';
    expect(extractInlineFields(line)).toEqual({
      status: null,
      priority: null,
      due: null,
    });
  });

  it('due が YYYY-MM-DD 形式でも月が不正 (00) なら null を返す', () => {
    const line = '- [ ] タスク [due:: 2026-00-15]';
    expect(extractInlineFields(line)).toEqual({
      status: null,
      priority: null,
      due: null,
    });
  });

  it('due が正しい YYYY-MM-DD なら返す', () => {
    const line = '- [ ] タスク [due:: 2026-12-31]';
    expect(extractInlineFields(line)).toEqual({
      status: null,
      priority: null,
      due: '2026-12-31',
    });
  });

  // ---- AC-Se3b7a2-1-4 (e): status/priority の大文字 → 小文字化して返す ----

  it('status 値の大文字を小文字化する', () => {
    const line = '- [ ] タスク [status:: Progress]';
    expect(extractInlineFields(line)).toEqual({
      status: 'progress',
      priority: null,
      due: null,
    });
  });

  it('status 値の全大文字 DONE を done に変換する', () => {
    const line = '- [x] タスク [status:: DONE]';
    expect(extractInlineFields(line)).toEqual({
      status: 'done',
      priority: null,
      due: null,
    });
  });

  it('priority 値の大文字を小文字化する', () => {
    const line = '- [ ] タスク [priority:: HIGH]';
    expect(extractInlineFields(line)).toEqual({
      status: null,
      priority: 'high',
      due: null,
    });
  });

  // ---- 同一キーが複数ある場合は最初のものを採用 ----

  it('同一キーが複数あれば最初のフィールドを使う', () => {
    const line = '- [ ] タスク [status:: todo] [status:: done]';
    expect(extractInlineFields(line)).toEqual({
      status: 'todo',
      priority: null,
      due: null,
    });
  });

  // ---- NFC 正規化 ----

  it('NFC 正規化が適用される (NFD 入力)', () => {
    // NFD 形式の日本語 (濁点分解)
    const nfd = 'プロ'.normalize('NFD');
    const line = `- [ ] タスク [status:: ${nfd}グレス]`;
    const result = extractInlineFields(line);
    expect(result.status).toBe('プログレス');
  });

  // ---- スペースを含む値 ----

  it('スペースを含む status 値を返す (ハイフン区切り等)', () => {
    const line = '- [ ] タスク [status:: in progress]';
    expect(extractInlineFields(line)).toEqual({
      status: 'in progress',
      priority: null,
      due: null,
    });
  });
});

describe('setInlineField', () => {
  // ---- フィールドの追加 ----

  it('フィールドが存在しない場合に行末に追記する', () => {
    const line = '- [ ] タスク';
    expect(setInlineField(line, 'status', 'progress')).toBe('- [ ] タスク [status:: progress]');
  });

  it('priority が存在しない場合に行末に追記する', () => {
    const line = '- [ ] タスク [status:: todo]';
    expect(setInlineField(line, 'priority', 'high')).toBe(
      '- [ ] タスク [status:: todo] [priority:: high]',
    );
  });

  it('due が存在しない場合に行末に追記する', () => {
    const line = '- [ ] タスク';
    expect(setInlineField(line, 'due', '2026-07-25')).toBe(
      '- [ ] タスク [due:: 2026-07-25]',
    );
  });

  // ---- フィールドの置換 ----

  it('既存の status フィールドを置換する', () => {
    const line = '- [ ] タスク [status:: todo]';
    expect(setInlineField(line, 'status', 'done')).toBe('- [ ] タスク [status:: done]');
  });

  it('既存の due フィールドを置換する', () => {
    const line = '- [ ] タスク [due:: 2026-07-01]';
    expect(setInlineField(line, 'due', '2026-08-01')).toBe(
      '- [ ] タスク [due:: 2026-08-01]',
    );
  });

  // ---- フィールドの削除 (value = null) ----

  it('value が null の場合にフィールドを削除する', () => {
    const line = '- [ ] タスク [status:: todo]';
    expect(setInlineField(line, 'status', null)).toBe('- [ ] タスク');
  });

  it('value が undefined の場合にフィールドを削除する', () => {
    const line = '- [ ] タスク [status:: todo]';
    expect(setInlineField(line, 'status', undefined)).toBe('- [ ] タスク');
  });

  it('存在しないフィールドを null で削除しても変化しない', () => {
    const line = '- [ ] タスク';
    expect(setInlineField(line, 'status', null)).toBe('- [ ] タスク');
  });

  it('複数フィールドがある場合に特定フィールドのみ削除する', () => {
    const line = '- [ ] タスク [status:: todo] [priority:: high]';
    expect(setInlineField(line, 'status', null)).toBe('- [ ] タスク [priority:: high]');
  });

  // ---- キーは小文字化して保存 ----

  it('key を小文字化して保存する', () => {
    const line = '- [ ] タスク';
    expect(setInlineField(line, 'STATUS', 'progress')).toBe(
      '- [ ] タスク [status:: progress]',
    );
  });
});
