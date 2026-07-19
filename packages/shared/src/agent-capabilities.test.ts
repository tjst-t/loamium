/**
 * [AC-S5bd678-1-1] resolvePermissions / deriveToolNames / help 常時広告。
 * [AC-S5bd678-1-2] clampByMode (実効権限 = 権限 ∩ LOAMIUM_MODE)。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITIES,
  AGENT_PRESETS,
  SETTINGS_EXCLUDED_TOOL_NAMES,
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

  it('AGENT_CAPABILITIES に smartfolder_write が含まれる (Sc4b9d1-1)', () => {
    expect(AGENT_CAPABILITIES).toContain('smartfolder_write');
  });

  it('AGENT_CAPABILITIES に command_write が含まれる (agent-write-coverage)', () => {
    expect(AGENT_CAPABILITIES).toContain('command_write');
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

  it('プリセット名 full は全ケーパビリティを解決する', () => {
    expect(resolvePermissions('full')).toEqual([...AGENT_CAPABILITIES]);
    expect(resolvePermissions('full')).toHaveLength(AGENT_CAPABILITIES.length);
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
  it('read → 読み取り群 + スマートフォルダ読み取り + commands/templates 一覧 (Sc4b9d1)', () => {
    expect(deriveToolNames(['read'])).toEqual([
      'backlinks',
      'commands_list',
      'help',
      'query',
      'read_note',
      'search',
      'smartfolder_notes',
      'smartfolders_list',
      'tags',
      'templates_list',
    ]);
  });

  it('smartfolder_write → [smartfolder_delete, smartfolder_write] (+ help 常時) (Sc4b9d1-1)', () => {
    expect(deriveToolNames(['smartfolder_write'])).toEqual([
      'help',
      'smartfolder_delete',
      'smartfolder_write',
    ]);
  });

  it('journal_append → [journal_append] (+ help 常時)', () => {
    expect(deriveToolNames(['journal_append'])).toEqual(['help', 'journal_append']);
  });

  it('note_create → [note_create] (+ help 常時)', () => {
    expect(deriveToolNames(['note_create'])).toEqual(['help', 'note_create']);
  });

  it('note_edit → [note_edit, note_move, note_property] (+ help 常時) (agent-write-coverage)', () => {
    expect(deriveToolNames(['note_edit'])).toEqual([
      'help',
      'note_edit',
      'note_move',
      'note_property',
    ]);
  });

  it('file_write → [file_delete, file_move, file_write] (+ help 常時) (agent-write-coverage)', () => {
    expect(deriveToolNames(['file_write'])).toEqual([
      'file_delete',
      'file_move',
      'file_write',
      'help',
    ]);
  });

  it('note_delete → [note_delete] (+ help 常時) (agent-write-coverage)', () => {
    expect(deriveToolNames(['note_delete'])).toEqual(['help', 'note_delete']);
  });

  it('template_write → [template_delete, template_instantiate, template_write] (+ help 常時)', () => {
    expect(deriveToolNames(['template_write'])).toEqual([
      'help',
      'template_delete',
      'template_instantiate',
      'template_write',
    ]);
  });

  it('command_run → [command_run] (+ help 常時) (Sc4b9d1-2)', () => {
    expect(deriveToolNames(['command_run'])).toEqual(['command_run', 'help']);
  });

  it('command_write → [command_delete, command_write] (+ help 常時)', () => {
    expect(deriveToolNames(['command_write'])).toEqual([
      'command_delete',
      'command_write',
      'help',
    ]);
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
      'commands_list',
      'help',
      'note_create',
      'note_edit',
      'note_move',
      'note_property',
      'query',
      'read_note',
      'search',
      'smartfolder_notes',
      'smartfolders_list',
      'tags',
      'templates_list',
    ]);
  });

  it('[AC-S5e0206-1-1] full プリセットは全書き込みツール + read 群 + smartfolder + commands/templates + vault_seed + web', () => {
    expect(deriveToolNames(AGENT_PRESETS.full)).toEqual([
      'backlinks',
      'command_delete',
      'command_run',
      'command_write',
      'commands_list',
      'dataview_write',
      'file_delete',
      'file_move',
      'file_write',
      'help',
      'journal_append',
      'note_create',
      'note_delete',
      'note_edit',
      'note_move',
      'note_property',
      'query',
      'read_note',
      'search',
      'smartfolder_delete',
      'smartfolder_notes',
      'smartfolder_write',
      'smartfolders_list',
      'tags',
      'template_delete',
      'template_instantiate',
      'template_write',
      'templates_list',
      'vault_seed',
      'web_fetch',
      'web_search',
    ]);
  });
});

// ---- AC-Sa10026-6-1/6-2: 設定書込 API の agent ツール除外 (自己昇格防止) ----

describe('[AC-Sa10026-6-1] deriveToolNames が設定書込ツールを含まない (構造的除外)', () => {
  it('全ケーパビリティ (full プリセット) の toolset に設定書込ツールが含まれない', () => {
    const allTools = deriveToolNames([...AGENT_CAPABILITIES]);
    for (const excluded of SETTINGS_EXCLUDED_TOOL_NAMES) {
      expect(allTools).not.toContain(excluded);
    }
  });

  it('read-only プリセットの toolset に設定書込ツールが含まれない', () => {
    const tools = deriveToolNames(AGENT_PRESETS['read-only']);
    for (const excluded of SETTINGS_EXCLUDED_TOOL_NAMES) {
      expect(tools).not.toContain(excluded);
    }
  });

  it('notes-rw プリセットの toolset に設定書込ツールが含まれない', () => {
    const tools = deriveToolNames(AGENT_PRESETS['notes-rw']);
    for (const excluded of SETTINGS_EXCLUDED_TOOL_NAMES) {
      expect(tools).not.toContain(excluded);
    }
  });

  it('[AC-Sa10026-6-2] full プリセットの advertised-toolset は固定 31 種のみ (settings 書込ツールが混入しない回帰 pin)', () => {
    // このアサートを削除・弱体化しないこと (Sa10026-6 の回帰防止 pin)。
    // 設定書込ツールを CAPABILITY_TOOL_NAMES に追加した場合、このテストが失敗し
    // 自己昇格の危険を検出する。
    // Sc4b9d1-1: スマートフォルダ 4 ツール (list/notes/write/delete) を追加し 13→17 種。
    // Sc4b9d1-2/3: commands (commands_list/command_run) + templates
    //   (templates_list/template_instantiate) 4 ツールを追加し 17→21 種。
    // agent-write-coverage: command_write ケーパビリティ (command_write/command_delete) を
    //   追加し 21→23 種。さらに note_property (note_edit へ畳む) / note_delete (独立ケーパビリティ) /
    //   template_delete (template_write へ畳む) を追加し 23→26 種。
    // agent-write-coverage 最終ウェーブ: note_move (note_edit へ畳む) + 添付ファイル
    //   file_write ケーパビリティ (file_write/file_move/file_delete) を追加し 26→30 種。
    // S7e2d5c-1: vault_seed ケーパビリティ (vault_seed ツール) を追加し 30→31 種。
    expect(deriveToolNames(AGENT_PRESETS.full)).toEqual([
      'backlinks',
      'command_delete',
      'command_run',
      'command_write',
      'commands_list',
      'dataview_write',
      'file_delete',
      'file_move',
      'file_write',
      'help',
      'journal_append',
      'note_create',
      'note_delete',
      'note_edit',
      'note_move',
      'note_property',
      'query',
      'read_note',
      'search',
      'smartfolder_delete',
      'smartfolder_notes',
      'smartfolder_write',
      'smartfolders_list',
      'tags',
      'template_delete',
      'template_instantiate',
      'template_write',
      'templates_list',
      'vault_seed',
      'web_fetch',
      'web_search',
    ]);
    // ちょうど 31 種であること (設定書込ツール混入で増えたら失敗)
    expect(deriveToolNames(AGENT_PRESETS.full)).toHaveLength(31);
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

  it('smartfolder_write は full のみ許可 (read-only/append-only で除外) (Sc4b9d1-1)', () => {
    expect(clampByMode(['read', 'smartfolder_write'], 'full')).toEqual(['read', 'smartfolder_write']);
    expect(clampByMode(['read', 'smartfolder_write'], 'read-only')).toEqual(['read']);
    expect(clampByMode(['read', 'smartfolder_write'], 'append-only')).toEqual(['read']);
  });

  it('command_run は full のみ許可 (read-only/append-only で除外) (Sc4b9d1-2)', () => {
    expect(clampByMode(['read', 'command_run'], 'full')).toEqual(['read', 'command_run']);
    expect(clampByMode(['read', 'command_run'], 'read-only')).toEqual(['read']);
    expect(clampByMode(['read', 'command_run'], 'append-only')).toEqual(['read']);
  });

  it('command_write は full のみ許可 (read-only/append-only で除外)', () => {
    expect(clampByMode(['read', 'command_write'], 'full')).toEqual(['read', 'command_write']);
    expect(clampByMode(['read', 'command_write'], 'read-only')).toEqual(['read']);
    expect(clampByMode(['read', 'command_write'], 'append-only')).toEqual(['read']);
  });

  it('note_delete は full のみ許可 (read-only/append-only で除外) (agent-write-coverage)', () => {
    expect(clampByMode(['read', 'note_delete'], 'full')).toEqual(['read', 'note_delete']);
    expect(clampByMode(['read', 'note_delete'], 'read-only')).toEqual(['read']);
    expect(clampByMode(['read', 'note_delete'], 'append-only')).toEqual(['read']);
  });

  it('file_write は full のみ許可 (read-only/append-only で除外) (agent-write-coverage)', () => {
    expect(clampByMode(['read', 'file_write'], 'full')).toEqual(['read', 'file_write']);
    expect(clampByMode(['read', 'file_write'], 'read-only')).toEqual(['read']);
    expect(clampByMode(['read', 'file_write'], 'append-only')).toEqual(['read']);
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
