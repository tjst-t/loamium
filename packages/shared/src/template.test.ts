/**
 * S89a350-1 変数エンジン + 日付フォーマットのユニットテスト。
 * shared のパーサー系は必須 (CLAUDE.md)。
 */
import { describe, expect, it } from 'vitest';
import {
  formatDate,
  resolveTemplate,
  sanitizePathValue,
  templateVariableNames,
} from './template.js';
import { journalPath, todayJournalDate } from './journal.js';
import { normalizeVaultPath } from './path.js';

describe('[AC-S89a350-1-1] {{name}} 変数置換と未定義検出', () => {
  it('定義済み変数を値で置換する', () => {
    const res = resolveTemplate('# {{会議名}} ({{カテゴリ}})', {
      vars: { 会議名: '定例会議', カテゴリ: '定例' },
    });
    expect(res.text).toBe('# 定例会議 (定例)');
    expect(res.missing).toEqual([]);
  });

  it('未定義変数はトークンを残し、不足変数名の一覧を返す', () => {
    const res = resolveTemplate('{{タイトル}} / {{著者}} / {{タイトル}}', { vars: {} });
    // 未解決トークンは verbatim
    expect(res.text).toBe('{{タイトル}} / {{著者}} / {{タイトル}}');
    // 出現順・重複排除
    expect(res.missing).toEqual(['タイトル', '著者']);
  });

  it('空文字の値は「指定済み」扱いで空に展開する (missing にしない)', () => {
    const res = resolveTemplate('a{{x}}b', { vars: { x: '' } });
    expect(res.text).toBe('ab');
    expect(res.missing).toEqual([]);
  });

  it('前後の空白を無視してトークン名を解決する', () => {
    const res = resolveTemplate('{{  会議名  }}', { vars: { 会議名: 'X' } });
    expect(res.text).toBe('X');
  });

  it('{{}} や壊れたトークンは記法として扱わない', () => {
    const res = resolveTemplate('{{}} {single} }}{{', { vars: {} });
    expect(res.text).toBe('{{}} {single} }}{{');
    expect(res.missing).toEqual([]);
  });

  it('templateVariableNames はプリセットを除外して変数名だけ返す', () => {
    expect(
      templateVariableNames('{{date:YYYY}}/{{会議名}}_{{now:HH}}_{{カテゴリ}}'),
    ).toEqual(['会議名', 'カテゴリ']);
  });
});

describe('[AC-S89a350-1-2] {{date:FORMAT}} / {{now:FORMAT}} の整形', () => {
  const base = new Date(2026, 6, 6, 9, 4, 7); // 2026-07-06 09:04:07 ローカル

  it('YYYY/MM/DD/HH/mm/ss トークンを 0 詰めで整形する', () => {
    expect(formatDate('YYYY-MM-DD HH:mm:ss', base)).toBe('2026-07-06 09:04:07');
  });

  it('MM(月) と mm(分)、HH(時) を大小で区別する', () => {
    expect(formatDate('MM/mm', base)).toBe('07/04');
    expect(formatDate('HH', base)).toBe('09');
  });

  it('リテラル文字はそのまま通す', () => {
    expect(formatDate('議事録/YYYY年MM月DD日', base)).toBe('議事録/2026年07月06日');
  });

  it('{{date:YYYY-MM-DD}} は既存 journalPath と同じ文字列を再現する', () => {
    const dateStr = todayJournalDate(base); // '2026-07-06'
    const res = resolveTemplate('{{date:YYYY-MM-DD}}', { date: base });
    expect(res.text).toBe(dateStr);
    expect(journalPath(res.text)).toBe(journalPath(dateStr));
    expect(`journals/${res.text}.md`).toBe(journalPath('2026-07-06'));
  });

  it('date は date 基準日、now は now 基準時刻を使う (注入可能)', () => {
    const dateBase = new Date(2020, 0, 2, 0, 0, 0); // 2020-01-02
    const nowBase = new Date(2026, 6, 6, 23, 30, 0); // 2026-07-06 23:30
    const res = resolveTemplate('{{date:YYYY-MM-DD}} @ {{now:HH-mm}}', {
      date: dateBase,
      now: nowBase,
    });
    expect(res.text).toBe('2020-01-02 @ 23-30');
  });

  it('date 未指定時は now を基準日にフォールバックする', () => {
    const res = resolveTemplate('{{date:YYYY}}', { now: base });
    expect(res.text).toBe('2026');
  });
});

describe('[AC-S89a350-1-3] パスサニタイズ + normalizeVaultPath 通過', () => {
  it('パス区切りを除去する', () => {
    expect(sanitizePathValue('a/b\\c')).toBe('abc');
  });

  it('.. (traversal) を単一ドットに潰す', () => {
    expect(sanitizePathValue('..')).toBe('');
    expect(sanitizePathValue('a..b')).toBe('a.b');
    expect(sanitizePathValue('../../etc')).toBe('etc');
  });

  it('制御文字を除去する', () => {
    // NUL / US / DEL を文字コードで構築 (ソースに生の制御文字を入れない)
    const withCtrl = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x1f) + 'c' + String.fromCharCode(0x7f) + 'd';
    expect(sanitizePathValue(withCtrl)).toBe('abcd');
  });

  it('先頭・末尾のドット/空白を除去する (隠しセグメント化を防ぐ)', () => {
    expect(sanitizePathValue('  .hidden  ')).toBe('hidden');
    expect(sanitizePathValue('.git')).toBe('git');
  });

  it('pathMode では変数値をサニタイズしてから展開する', () => {
    const res = resolveTemplate('議事録/{{会議名}}', {
      vars: { 会議名: '2026/07 定例..' },
      pathMode: true,
    });
    // `/` 除去・末尾 `..` 除去
    expect(res.text).toBe('議事録/202607 定例');
  });

  it('本文解決 (pathMode 無し) では値を verbatim に保つ', () => {
    const res = resolveTemplate('メモ: {{会議名}}', { vars: { 会議名: 'A/B..C' } });
    expect(res.text).toBe('メモ: A/B..C');
  });

  it('サニタイズ + 展開結果は normalizeVaultPath を通過する', () => {
    const target = resolveTemplate('議事録/{{date:YYYY}}/{{date:MM}}/{{date:DD}}_{{会議名}}', {
      vars: { 会議名: '../secret/例会' },
      date: new Date(2026, 6, 6),
      pathMode: true,
    });
    expect(target.missing).toEqual([]);
    const norm = normalizeVaultPath(target.text);
    expect(norm).toBe('議事録/2026/07/06_secret例会.md');
    // traversal・隠しセグメントが残っていない
    expect(norm.split('/').some((s) => s === '..' || s.startsWith('.'))).toBe(false);
  });

  it('悪意ある変数値でも vault 外へ脱出できない', () => {
    const target = resolveTemplate('notes/{{名前}}', {
      vars: { 名前: '../../../../etc/passwd' },
      pathMode: true,
    });
    // `/` と先頭 `..` が除去され 1 セグメントに閉じ込められる
    expect(() => normalizeVaultPath(target.text)).not.toThrow();
    expect(normalizeVaultPath(target.text)).toBe('notes/etcpasswd.md');
  });
});
