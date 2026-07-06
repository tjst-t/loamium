/**
 * S67ea41-1 journal 遅延生成向けテンプレート適用のユニットテスト。
 * shared のパーサー系 + 日付処理は必須 (CLAUDE.md)。
 *
 * 検証の要点:
 * - buildBodyTemplate が loamium-template ブロックを除いた本文テンプレートを組む
 * - applyJournalTemplate が対象日基準で {{date:...}} を展開する
 * - 宣言済み変数 default を対象日基準で解決し、default 無し変数は空文字で解決する
 * - 結果は解決済みピュア Markdown ({{...}} 非残存 — priority 1)
 */
import { describe, expect, it } from 'vitest';
import { applyJournalTemplate, buildBodyTemplate, parseTemplateConfig } from './template-note.js';
import { formatDate } from './template.js';
import { journalDateToLocalDate } from './journal.js';
import { parseNote } from './markdown.js';

const DAILY_TEMPLATE = [
  '---',
  'loamium-template:',
  '  description: デイリージャーナル',
  'tags: [journal]',
  '---',
  '# {{date:YYYY-MM-DD}} ({{date:MM}}/{{date:DD}})',
  '',
  '## やること',
  '',
].join('\n');

describe('[AC-S67ea41-1-1] buildBodyTemplate が loamium-template ブロックを除去する', () => {
  it('残りフロントマター + 本文を返し、loamium-template は残さない', () => {
    const body = buildBodyTemplate(DAILY_TEMPLATE);
    expect(body).not.toContain('loamium-template');
    // 作者の他フロントマターは verbatim 保持
    expect(body).toContain('tags: [journal]');
    expect(body.startsWith('---\ntags: [journal]\n---\n')).toBe(true);
  });

  it('frontmatter 無しファイルは全体が本文テンプレート', () => {
    const t = '# {{date:YYYY-MM-DD}}\n\n本文\n';
    expect(buildBodyTemplate(t)).toBe(t);
  });

  it('loamium-template のみのフロントマターは本文のみになる', () => {
    const t = ['---', 'loamium-template:', '  target: "journals/x"', '---', '# 本文', ''].join('\n');
    expect(buildBodyTemplate(t)).toBe('# 本文\n');
  });
});

describe('[AC-S67ea41-1-2] applyJournalTemplate が対象日基準で {{date:...}} を展開する', () => {
  it('今日基準で journalPath と同一の日付文字列を再現する', () => {
    const date = '2026-07-06';
    const base = journalDateToLocalDate(date);
    const out = applyJournalTemplate(DAILY_TEMPLATE, { date: base, now: new Date() });
    expect(out).toContain('# 2026-07-06 (07/06)');
    // 結果は解決済みピュア Markdown ({{...}} 非残存)
    expect(out).not.toContain('{{');
    // formatDate と一致
    expect(out).toContain(formatDate('YYYY-MM-DD', base));
  });

  it('未来日 (明日) ジャーナルは対象日基準で展開される', () => {
    const date = '2026-12-31';
    const base = journalDateToLocalDate(date);
    const out = applyJournalTemplate(DAILY_TEMPLATE, { date: base, now: new Date() });
    expect(out).toContain('# 2026-12-31 (12/31)');
  });

  it('過去日ジャーナルは対象日基準で展開される (now ではなく date を使う)', () => {
    const date = '2020-01-02';
    const base = journalDateToLocalDate(date);
    const out = applyJournalTemplate(DAILY_TEMPLATE, { date: base, now: new Date() });
    expect(out).toContain('# 2020-01-02 (01/02)');
    expect(out).not.toContain('{{');
  });
});

describe('[AC-S67ea41-1-2] 変数の default は対象日基準で解決し、default 無しは空文字', () => {
  it('宣言済み変数 default を対象日基準で展開する', () => {
    const tmpl = [
      '---',
      'loamium-template:',
      '  vars:',
      '    - name: 見出し日',
      '      type: date',
      '      default: "{{date:YYYY-MM-DD}}"',
      '---',
      '日付: {{見出し日}}',
      '',
    ].join('\n');
    const base = journalDateToLocalDate('2026-03-15');
    const out = applyJournalTemplate(tmpl, { date: base, now: new Date() });
    expect(out).toContain('日付: 2026-03-15');
    expect(out).not.toContain('{{');
  });

  it('default の無い参照変数は空文字で解決し、記法を残さない', () => {
    const tmpl = ['---', 'title: "{{タイトル}}"', '---', '本文 {{メモ}}', ''].join('\n');
    const base = journalDateToLocalDate('2026-03-15');
    const out = applyJournalTemplate(tmpl, { date: base, now: new Date() });
    expect(out).not.toContain('{{');
    expect(out).toContain('title: ""');
    expect(out).toContain('本文 ');
  });
});

describe('parseTemplateConfig は壊れた loamium-template をフォールバックする', () => {
  it('オブジェクトでない loamium-template は純粋雛形 (target=null) へ', () => {
    const t = ['---', 'loamium-template: "壊れ"', '---', '# x', ''].join('\n');
    const cfg = parseTemplateConfig(parseNote(t).frontmatter);
    expect(cfg.target).toBeNull();
    expect(cfg.vars).toEqual([]);
  });
});
