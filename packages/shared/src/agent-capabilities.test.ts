/**
 * [AC-S5bd678-1-1] resolvePermissions / deriveToolNames / help 常時広告。
 * [AC-S5bd678-1-2] clampByMode (実効権限 = 権限 ∩ LOAMIUM_MODE)。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITIES,
  AGENT_PRESETS,
  agentPermissionsSchema,
  clampByMode,
  deriveToolNames,
  resolvePermissions,
  type Capability,
} from './agent-capabilities.js';

describe('[AC-S5bd678-1-1] resolvePermissions', () => {
  it('未指定 (undefined) は read-only プリセット ([read]) を返す', () => {
    expect(resolvePermissions(undefined)).toEqual(['read']);
  });

  it('プリセット名 read-only を解決する', () => {
    expect(resolvePermissions('read-only')).toEqual(['read']);
  });

  it('プリセット名 notes-rw を解決する', () => {
    expect(resolvePermissions('notes-rw')).toEqual([
      'read',
      'journal_append',
      'note_create',
      'note_edit',
    ]);
  });

  it('プリセット名 full は全 7 ケーパビリティを解決する', () => {
    expect(resolvePermissions('full')).toEqual([...AGENT_CAPABILITIES]);
    expect(resolvePermissions('full')).toHaveLength(7);
  });

  it('ケーパビリティ配列をそのまま (AGENT_CAPABILITIES 順に正規化して) 解決する', () => {
    expect(resolvePermissions(['note_edit', 'read'])).toEqual(['read', 'note_edit']);
  });

  it('ケーパビリティ配列の重複を排除する', () => {
    expect(resolvePermissions(['read', 'read', 'web'])).toEqual(['read', 'web']);
  });

  it('プリセット結果は不変ソースを共有せずコピーを返す (呼び出し側の変更が漏れない)', () => {
    const caps = resolvePermissions('read-only');
    caps.push('web');
    expect(AGENT_PRESETS['read-only']).toEqual(['read']);
  });
});

describe('[AC-S5bd678-1-1] agentPermissionsSchema', () => {
  it('プリセット名を受理する', () => {
    expect(agentPermissionsSchema.parse('full')).toBe('full');
  });

  it('ケーパビリティ配列を受理する', () => {
    expect(agentPermissionsSchema.parse(['read', 'note_edit'])).toEqual(['read', 'note_edit']);
  });

  it('未知のプリセット名 / ケーパビリティを拒否する', () => {
    expect(agentPermissionsSchema.safeParse('super-admin').success).toBe(false);
    expect(agentPermissionsSchema.safeParse(['read', 'nope']).success).toBe(false);
  });
});

describe('[AC-S5bd678-1-1] deriveToolNames', () => {
  it('read → 読み取り 6 種 (backlinks/help/query/read_note/search/tags)', () => {
    expect(deriveToolNames(['read'])).toEqual([
      'backlinks',
      'help',
      'query',
      'read_note',
      'search',
      'tags',
    ]);
  });

  it('journal_append → [journal_append] (+ help 常時)', () => {
    expect(deriveToolNames(['journal_append'])).toEqual(['help', 'journal_append']);
  });

  it('note_create → [note_create] (+ help 常時)', () => {
    expect(deriveToolNames(['note_create'])).toEqual(['help', 'note_create']);
  });

  it('note_edit → [note_edit] (+ help 常時)', () => {
    expect(deriveToolNames(['note_edit'])).toEqual(['help', 'note_edit']);
  });

  it('template_write → [template_write] (+ help 常時)', () => {
    expect(deriveToolNames(['template_write'])).toEqual(['help', 'template_write']);
  });

  it('dataview_write → [dataview_write] (+ help 常時)', () => {
    expect(deriveToolNames(['dataview_write'])).toEqual(['dataview_write', 'help']);
  });

  it('[AC-S5e0206-1-1] web → [web_fetch, web_search] (+ help 常時)', () => {
    expect(deriveToolNames(['web'])).toEqual(['help', 'web_fetch', 'web_search']);
  });

  it('help 常時広告: caps が空でも help だけは広告する (ADR-0014)', () => {
    expect(deriveToolNames([])).toEqual(['help']);
  });

  it('複数ケーパビリティを重複排除・ソートして統合する', () => {
    expect(deriveToolNames(['read', 'note_create', 'note_edit'])).toEqual([
      'backlinks',
      'help',
      'note_create',
      'note_edit',
      'query',
      'read_note',
      'search',
      'tags',
    ]);
  });

  it('[AC-S5e0206-1-1] full プリセットは全書き込みツール + read 群 + web (web_fetch/web_search)', () => {
    expect(deriveToolNames(AGENT_PRESETS.full)).toEqual([
      'backlinks',
      'dataview_write',
      'help',
      'journal_append',
      'note_create',
      'note_edit',
      'query',
      'read_note',
      'search',
      'tags',
      'template_write',
      'web_fetch',
      'web_search',
    ]);
  });
});

describe('[AC-S5bd678-1-2] clampByMode', () => {
  const full: Capability[] = [...AGENT_CAPABILITIES];

  it('full モードは恒等 (すべて残す)', () => {
    expect(clampByMode(full, 'full')).toEqual(full);
  });

  it('read-only モードは {read, web} のみ残す', () => {
    expect(clampByMode(full, 'read-only')).toEqual(['read', 'web']);
  });

  it('append-only モードは {read, web, journal_append} のみ残す', () => {
    expect(clampByMode(full, 'append-only')).toEqual(['read', 'journal_append', 'web']);
  });

  it('read-only モードは書き込みケーパビリティを取り除く', () => {
    expect(clampByMode(['note_create', 'note_edit'], 'read-only')).toEqual([]);
  });

  it('append-only モードは journal_append は残すが他書き込みは落とす', () => {
    expect(clampByMode(['journal_append', 'note_edit'], 'append-only')).toEqual([
      'journal_append',
    ]);
  });

  it('クランプ結果も AGENT_CAPABILITIES 順に正規化される', () => {
    expect(clampByMode(['web', 'read'], 'read-only')).toEqual(['read', 'web']);
  });
});
