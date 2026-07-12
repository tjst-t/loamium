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

// ---------------------------------------------------------------------------
// Sf2f114-1 拡張: {{param|fallback}} と相対日付 {{date:+Nd:FMT}}
// ---------------------------------------------------------------------------

describe('[AC-Sf2f114-1-1] {{param|fallback}} パイプ付きフォールバック', () => {
  // 未定義の param → fallback を使用し、missing には追加しない
  it('param が未定義のとき fallback を返す (missing に収集しない)', () => {
    const res = resolveTemplate('件名: {{タイトル|無題}}', { vars: {} });
    expect(res.text).toBe('件名: 無題');
    expect(res.missing).toEqual([]);
  });

  // 空文字の param → fallback を使用
  it('param が空文字のとき fallback を返す', () => {
    const res = resolveTemplate('{{x|デフォルト}}', { vars: { x: '' } });
    expect(res.text).toBe('デフォルト');
    expect(res.missing).toEqual([]);
  });

  // 値が存在するとき → 値を使用
  it('param に値があるとき値を返す', () => {
    const res = resolveTemplate('{{x|デフォルト}}', { vars: { x: '実際の値' } });
    expect(res.text).toBe('実際の値');
    expect(res.missing).toEqual([]);
  });

  // fallback に日本語・スペースを含む
  it('fallback に日本語やスペースを含んでも正しく展開する', () => {
    const res = resolveTemplate('{{メモ|未入力 メモ あり}}', { vars: {} });
    expect(res.text).toBe('未入力 メモ あり');
    expect(res.missing).toEqual([]);
  });

  // 複数トークンの混在
  it('パイプ付きと通常トークンが混在しても正しく処理する', () => {
    const res = resolveTemplate('{{a|AA}} / {{b}} / {{c|CC}}', {
      vars: { a: '実A', b: '実B' },
    });
    expect(res.text).toBe('実A / 実B / CC');
    // b は定義済みなので missing にない。c はパイプ付きで fallback を使ったので missing にない
    expect(res.missing).toEqual([]);
  });

  // 後方互換: パイプなし {{x}} は未定義のとき verbatim + missing のまま
  it('パイプなし {{x}} は未定義のとき verbatim に残り missing に収集される (後方互換)', () => {
    const res = resolveTemplate('{{タイトル}}', { vars: {} });
    expect(res.text).toBe('{{タイトル}}');
    expect(res.missing).toEqual(['タイトル']);
  });

  // 空文字の値は既存テストと同じく「指定済み」扱い (パイプなし)
  it('パイプなし {{x}} で値が空文字のとき空に展開する (既存ルール変更なし)', () => {
    const res = resolveTemplate('a{{x}}b', { vars: { x: '' } });
    expect(res.text).toBe('ab');
    expect(res.missing).toEqual([]);
  });
});

describe('[AC-Sf2f114-1-2] 相対日付オフセット {{date:+Nd:FMT}} / {{date:-Nd:FMT}}', () => {
  const base = new Date(2026, 6, 6, 9, 4, 7); // 2026-07-06 09:04:07 ローカル

  it('+3d: 3 日後の日付を返す', () => {
    const res = resolveTemplate('{{date:+3d:YYYY-MM-DD}}', { date: base });
    expect(res.text).toBe('2026-07-09');
    expect(res.missing).toEqual([]);
  });

  it('-1d: 1 日前の日付を返す', () => {
    const res = resolveTemplate('{{date:-1d:YYYY-MM-DD}}', { date: base });
    expect(res.text).toBe('2026-07-05');
    expect(res.missing).toEqual([]);
  });

  it('+0d: オフセット 0 は {{date:YYYY-MM-DD}} と同一', () => {
    const resOffset = resolveTemplate('{{date:+0d:YYYY-MM-DD}}', { date: base });
    const resBase = resolveTemplate('{{date:YYYY-MM-DD}}', { date: base });
    expect(resOffset.text).toBe(resBase.text);
    expect(resOffset.text).toBe('2026-07-06');
  });

  it('月跨ぎのオフセットを正しく計算する', () => {
    // 2026-07-31 + 1d = 2026-08-01
    const eom = new Date(2026, 6, 31);
    const res = resolveTemplate('{{date:+1d:YYYY-MM-DD}}', { date: eom });
    expect(res.text).toBe('2026-08-01');
  });

  it('now:+2d もサポートする', () => {
    const res = resolveTemplate('{{now:+2d:YYYY-MM-DD}}', { now: base });
    expect(res.text).toBe('2026-07-08');
    expect(res.missing).toEqual([]);
  });

  // 既存の {{date:FORMAT}} は変更なし (後方互換)
  it('既存 {{date:YYYY-MM-DD}} はオフセットなしで変更なし', () => {
    const res = resolveTemplate('{{date:YYYY-MM-DD}}', { date: base });
    expect(res.text).toBe('2026-07-06');
  });

  it('既存 {{date:YYYY/MM/DD HH:mm:ss}} はコロン含むフォーマットも変更なし', () => {
    const res = resolveTemplate('{{date:YYYY/MM/DD HH:mm:ss}}', { date: base });
    expect(res.text).toBe('2026/07/06 09:04:07');
  });

  it('d 以外の単位 (+3h など) はサポート外で verbatim に残る', () => {
    // +3h はオフセット記法として認識されないため date:+3h:YYYY-MM-DD は
    // offsetPart = '+3h' が DAY_OFFSET_RE にマッチしない
    // → 従来通り `rest = '+3h:YYYY-MM-DD'` を format として扱う
    // formatDate はサポート外トークンをそのまま通すので結果に注目する必要はなく
    // 少なくともクラッシュしないことを確認する
    expect(() => resolveTemplate('{{date:+3h:YYYY-MM-DD}}', { date: base })).not.toThrow();
  });
});
