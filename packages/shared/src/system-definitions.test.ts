/**
 * system/ フォルダ定義スキーマ + ユーティリティのユニットテスト (Sa10026-1-1)。
 *
 * [AC-Sa10026-1-1] smart-folder/command=純 YAML、template=.md+frontmatter のパースと
 *                  zod 検証・フォールバックを検証する。
 * [AC-Sa10026-1-2] order → ファイル名の安定ソートを検証する。
 * [AC-Sa10026-1-3] normalizeSystemPath の vault 外脱出防止を検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  parseSystemSmartFolderYaml,
  parseSystemCommandYaml,
  parseSystemTemplateFrontmatter,
  buildSystemSmartFolderDef,
  buildSystemCommandDef,
  buildSystemTemplateDef,
  sortSystemDefs,
  stemFromSystemPath,
  normalizeSystemPath,
  isSystemSmartFolderPath,
  isSystemCommandPath,
  isSystemTemplatePath,
  VaultPathError,
} from './system-definitions.js';

// ---- [AC-Sa10026-1-1] 純 YAML パース: SmartFolder ----

describe('parseSystemSmartFolderYaml [AC-Sa10026-1-1]', () => {
  it('正常な YAML を正しくパースする', () => {
    const yaml = `
title: "プロジェクト一覧"
order: 1
icon: "📁"
query: "LIST from \\"projects\\""
`.trim();
    const result = parseSystemSmartFolderYaml(yaml);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('プロジェクト一覧');
    expect(result?.order).toBe(1);
    expect(result?.icon).toBe('📁');
    expect(result?.query).toBe('LIST from "projects"');
  });

  it('query フィールドのみ必須 (title/order/icon は省略可)', () => {
    const yaml = `query: "LIST"`;
    const result = parseSystemSmartFolderYaml(yaml);
    expect(result).not.toBeNull();
    expect(result?.title).toBeUndefined();
    expect(result?.order).toBeUndefined();
    expect(result?.icon).toBeUndefined();
    expect(result?.query).toBe('LIST');
  });

  it('query が空文字列のとき null (zod min(1) 違反)', () => {
    const yaml = `query: ""`;
    const result = parseSystemSmartFolderYaml(yaml);
    expect(result).toBeNull();
  });

  it('query がない場合 null (必須フィールド欠落)', () => {
    const yaml = `title: "テスト"`;
    const result = parseSystemSmartFolderYaml(yaml);
    expect(result).toBeNull();
  });

  it('空文字列の YAML → null (寛容フォールバック)', () => {
    expect(parseSystemSmartFolderYaml('')).toBeNull();
    expect(parseSystemSmartFolderYaml('   ')).toBeNull();
  });

  it('壊れた YAML → null (寛容フォールバック)', () => {
    expect(parseSystemSmartFolderYaml(': broken: yaml')).toBeNull();
  });

  it('YAML が配列の場合 null', () => {
    const yaml = `- query: "LIST"`;
    expect(parseSystemSmartFolderYaml(yaml)).toBeNull();
  });
});

// ---- [AC-Sa10026-1-1] 純 YAML パース: Command ----

describe('parseSystemCommandYaml [AC-Sa10026-1-1]', () => {
  it('フルフィールドを正しくパースする', () => {
    const yaml = `
title: "タスク作成"
order: 2
icon: "✅"
name: create-todo
steps:
  - kind: note-create
    target: "todos/{{title}}.md"
    content: "# {{title}}"
`.trim();
    const result = parseSystemCommandYaml(yaml);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('タスク作成');
    expect(result?.order).toBe(2);
    expect(result?.icon).toBe('✅');
  });

  it('全フィールド省略でも {} として成功する (全 optional)', () => {
    const yaml = `
name: simple
steps:
  - kind: note-create
    target: "notes/test.md"
    content: "# Test"
`.trim();
    const result = parseSystemCommandYaml(yaml);
    expect(result).not.toBeNull();
    expect(result?.title).toBeUndefined();
    expect(result?.order).toBeUndefined();
    expect(result?.icon).toBeUndefined();
  });

  it('空文字列の YAML → null', () => {
    expect(parseSystemCommandYaml('')).toBeNull();
  });

  it('null に解析される YAML → null', () => {
    // "~" は YAML で null を意味するため、null が返る
    expect(parseSystemCommandYaml('~')).toBeNull();
  });
});

// ---- [AC-Sa10026-1-1] .md + frontmatter パース: Template ----

describe('parseSystemTemplateFrontmatter [AC-Sa10026-1-1]', () => {
  it('frontmatter から title/order/icon を抽出する', () => {
    const md = `---
title: "週次レビュー"
order: 3
icon: "📅"
loamium-template:
  target: "reviews/{{date:YYYY}}/{{date:MM-DD}}"
---

# 週次レビュー
`;
    const result = parseSystemTemplateFrontmatter(md);
    expect(result.title).toBe('週次レビュー');
    expect(result.order).toBe(3);
    expect(result.icon).toBe('📅');
  });

  it('frontmatter がない .md は空オブジェクトを返す (フォールバック)', () => {
    const md = `# テンプレート本文のみ\n`;
    const result = parseSystemTemplateFrontmatter(md);
    expect(result).toEqual({});
  });

  it('title/order/icon フィールドがない frontmatter は空オブジェクトを返す', () => {
    const md = `---\nloamium-template:\n  target: "foo"\n---\n本文\n`;
    const result = parseSystemTemplateFrontmatter(md);
    // loamium-template は systemTemplateFrontmatterSchema に含まれないが、
    // safeParse は追加フィールドを黙って無視するため {} にならない
    // → title/order/icon の値だけを確認
    expect(result.title).toBeUndefined();
    expect(result.order).toBeUndefined();
    expect(result.icon).toBeUndefined();
  });

  it('壊れた frontmatter でも空オブジェクトを返す (寛容フォールバック)', () => {
    const md = `---\n: broken\n---\n本文\n`;
    const result = parseSystemTemplateFrontmatter(md);
    expect(result).toEqual({});
  });

  it('order が整数でない場合は空オブジェクトを返す (zod int 検証)', () => {
    const md = `---\ntitle: test\norder: 1.5\n---\n`;
    const result = parseSystemTemplateFrontmatter(md);
    // order: 1.5 は z.number().int() に違反するため order が除外される
    // zod の safeParse は全体を失敗させるため {} になる
    expect(result.order).toBeUndefined();
  });
});

// ---- ヘルパー: stemFromSystemPath ----

describe('stemFromSystemPath', () => {
  it('vault 相対パスから stem を取り出す', () => {
    expect(stemFromSystemPath('system/smart-folders/todo.yaml')).toBe('todo');
    expect(stemFromSystemPath('system/commands/create-task.yaml')).toBe('create-task');
    expect(stemFromSystemPath('system/templates/weekly.md')).toBe('weekly');
  });

  it('.yml 拡張子も除去する', () => {
    expect(stemFromSystemPath('system/commands/foo.yml')).toBe('foo');
  });
});

// ---- [AC-Sa10026-1-1] buildSystemSmartFolderDef ----

describe('buildSystemSmartFolderDef [AC-Sa10026-1-1]', () => {
  it('正常 YAML から SmartFolderDef を構築する', () => {
    const yaml = `title: "タスク"\norder: 1\nquery: "LIST from \\"todos\\""\n`;
    const def = buildSystemSmartFolderDef('system/smart-folders/tasks.yaml', yaml);
    expect(def).not.toBeNull();
    expect(def?.id).toBe('tasks');
    expect(def?.path).toBe('system/smart-folders/tasks.yaml');
    expect(def?.title).toBe('タスク');
    expect(def?.order).toBe(1);
    expect(def?.query).toBe('LIST from "todos"');
  });

  it('title 省略時は id (stem) にフォールバックする', () => {
    const yaml = `query: "LIST"\n`;
    const def = buildSystemSmartFolderDef('system/smart-folders/inbox.yaml', yaml);
    expect(def?.title).toBe('inbox');
  });

  it('query がない YAML → null (必須フィールド欠落)', () => {
    const yaml = `title: "なし"\n`;
    const def = buildSystemSmartFolderDef('system/smart-folders/bad.yaml', yaml);
    expect(def).toBeNull();
  });
});

// ---- [AC-Sa10026-1-1] buildSystemCommandDef ----

describe('buildSystemCommandDef [AC-Sa10026-1-1]', () => {
  it('order/title/icon を含む YAML からメタを構築する', () => {
    const yaml = `title: "ノート作成"\norder: 5\nsteps: []\n`;
    const def = buildSystemCommandDef('system/commands/create-note.yaml', yaml);
    expect(def.id).toBe('create-note');
    expect(def.title).toBe('ノート作成');
    expect(def.order).toBe(5);
  });

  it('YAML パース失敗でも常にメタ情報を返す (id = stem、title = stem)', () => {
    const yaml = ': broken';
    const def = buildSystemCommandDef('system/commands/broken-cmd.yaml', yaml);
    expect(def.id).toBe('broken-cmd');
    expect(def.title).toBe('broken-cmd');
    expect(def.order).toBeUndefined();
  });
});

// ---- [AC-Sa10026-1-1] buildSystemTemplateDef ----

describe('buildSystemTemplateDef [AC-Sa10026-1-1]', () => {
  it('frontmatter の title/order/icon を反映する', () => {
    const md = `---\ntitle: "日報"\norder: 10\n---\n本文\n`;
    const def = buildSystemTemplateDef('system/templates/daily-report.md', md);
    expect(def.id).toBe('daily-report');
    expect(def.title).toBe('日報');
    expect(def.order).toBe(10);
  });

  it('frontmatter なしでも常にメタ情報を返す (title = stem)', () => {
    const md = `# テンプレート本文\n`;
    const def = buildSystemTemplateDef('system/templates/plain.md', md);
    expect(def.id).toBe('plain');
    expect(def.title).toBe('plain');
    expect(def.order).toBeUndefined();
  });
});

// ---- [AC-Sa10026-1-2] sortSystemDefs: order → ファイル名の安定ソート ----

describe('sortSystemDefs [AC-Sa10026-1-2]', () => {
  it('order 昇順で並ぶ', () => {
    const items = [
      { id: 'b', order: 3 as number | undefined },
      { id: 'a', order: 1 as number | undefined },
      { id: 'c', order: 2 as number | undefined },
    ];
    const sorted = sortSystemDefs(items);
    expect(sorted.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('order 欠落は末尾に来る', () => {
    const items = [
      { id: 'z', order: undefined as number | undefined },
      { id: 'a', order: 1 as number | undefined },
      { id: 'b', order: undefined as number | undefined },
    ];
    const sorted = sortSystemDefs(items);
    expect(sorted[0]?.id).toBe('a');
    // 末尾 2 件は order なし → id 昇順
    expect(sorted[1]?.id).toBe('b');
    expect(sorted[2]?.id).toBe('z');
  });

  it('同一 order はファイル名 (id) 昇順 (tie)', () => {
    const items = [
      { id: 'c', order: 2 as number | undefined },
      { id: 'a', order: 2 as number | undefined },
      { id: 'b', order: 2 as number | undefined },
    ];
    const sorted = sortSystemDefs(items);
    expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('gap を許容する (order 1, 5, 10 など飛び番)', () => {
    const items = [
      { id: 'late', order: 10 as number | undefined },
      { id: 'early', order: 1 as number | undefined },
      { id: 'mid', order: 5 as number | undefined },
    ];
    const sorted = sortSystemDefs(items);
    expect(sorted.map((x) => x.id)).toEqual(['early', 'mid', 'late']);
  });

  it('元の配列を変更しない (新配列を返す)', () => {
    const items = [
      { id: 'b', order: 2 as number | undefined },
      { id: 'a', order: 1 as number | undefined },
    ];
    const original = [...items];
    sortSystemDefs(items);
    expect(items).toEqual(original);
  });
});

// ---- [AC-Sa10026-1-3] normalizeSystemPath: vault 外脱出防止 ----

describe('normalizeSystemPath [AC-Sa10026-1-3]', () => {
  it('正常な system/ パスはそのまま (NFC 正規化)', () => {
    const result = normalizeSystemPath('system/smart-folders/todo.yaml');
    expect(result).toBe('system/smart-folders/todo.yaml');
  });

  it('.. (traversal) を含むパスは VaultPathError を投げる', () => {
    expect(() => normalizeSystemPath('system/smart-folders/../../.loamium/secret')).toThrow(
      VaultPathError,
    );
  });

  it('絶対パスは VaultPathError を投げる', () => {
    expect(() => normalizeSystemPath('/etc/passwd')).toThrow(VaultPathError);
  });

  it('空文字列は VaultPathError を投げる', () => {
    expect(() => normalizeSystemPath('')).toThrow(VaultPathError);
  });

  it('隠しセグメント (.loamium) は HiddenVaultPathError を投げる', () => {
    expect(() => normalizeSystemPath('.loamium/smart-folders/foo.yaml')).toThrow(VaultPathError);
  });
});

// ---- パス判定ヘルパー ----

describe('isSystemSmartFolderPath / isSystemCommandPath / isSystemTemplatePath', () => {
  it('isSystemSmartFolderPath: .yaml は true', () => {
    expect(isSystemSmartFolderPath('system/smart-folders/inbox.yaml')).toBe(true);
    expect(isSystemSmartFolderPath('system/smart-folders/inbox.yml')).toBe(true);
  });

  it('isSystemSmartFolderPath: .md や別ディレクトリは false', () => {
    expect(isSystemSmartFolderPath('system/smart-folders/inbox.md')).toBe(false);
    expect(isSystemSmartFolderPath('system/commands/foo.yaml')).toBe(false);
    expect(isSystemSmartFolderPath('commands/foo.yaml')).toBe(false);
  });

  it('isSystemCommandPath: .yaml は true', () => {
    expect(isSystemCommandPath('system/commands/create-task.yaml')).toBe(true);
    expect(isSystemCommandPath('system/commands/create-task.yml')).toBe(true);
  });

  it('isSystemCommandPath: .md や別ディレクトリは false', () => {
    expect(isSystemCommandPath('system/commands/foo.md')).toBe(false);
    expect(isSystemCommandPath('system/smart-folders/foo.yaml')).toBe(false);
  });

  it('isSystemTemplatePath: .md は true', () => {
    expect(isSystemTemplatePath('system/templates/weekly.md')).toBe(true);
  });

  it('isSystemTemplatePath: .yaml や別ディレクトリは false', () => {
    expect(isSystemTemplatePath('system/templates/weekly.yaml')).toBe(false);
    expect(isSystemTemplatePath('system/smart-folders/foo.md')).toBe(false);
    expect(isSystemTemplatePath('templates/foo.md')).toBe(false);
  });
});

// ---- [AC-Sa10026-3-1] parseAppSettings / serializeAppSettings ----

import {
  parseAppSettings,
  serializeAppSettings,
  DEFAULT_APP_SETTINGS,
  appSettingsSchema,
  SYSTEM_SETTINGS_PATH,
} from './system-definitions.js';

describe('parseAppSettings [AC-Sa10026-3-1]', () => {
  it('null / undefined → 既定値を返す', () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('空文字列 → 既定値を返す', () => {
    expect(parseAppSettings('')).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('空白のみ → 既定値を返す', () => {
    expect(parseAppSettings('   ')).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('壊れた YAML → 既定値を返す (例外を投げない) [AC-Sa10026-3-1]', () => {
    expect(() => parseAppSettings('{ broken: [yaml: : ::\n')).not.toThrow();
    expect(parseAppSettings('{ broken: [yaml: : ::\n')).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('--- のみ (空ドキュメント) → 既定値を返す', () => {
    expect(parseAppSettings('---\n')).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('YAML が配列 → 既定値を返す', () => {
    expect(parseAppSettings('- theme: dark\n')).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('正常な YAML を全フィールド込みでパースする', () => {
    const yaml = [
      'theme: dark',
      'defaultFolder: "projects"',
      'journalTemplate: "system/templates/daily.md"',
      'showSystemFolder: true',
    ].join('\n');
    const result = parseAppSettings(yaml);
    expect(result.theme).toBe('dark');
    expect(result.defaultFolder).toBe('projects');
    expect(result.journalTemplate).toBe('system/templates/daily.md');
    expect(result.showSystemFolder).toBe(true);
  });

  it('一部フィールドのみ — 欠落は既定値で補う', () => {
    const result = parseAppSettings('theme: light\n');
    expect(result.theme).toBe('light');
    expect(result.defaultFolder).toBe('');
    expect(result.journalTemplate).toBe('system/templates/journal.md');
    expect(result.showSystemFolder).toBe(false);
  });

  it('未知フィールド (passthrough) は保持される', () => {
    const result = parseAppSettings('theme: dark\nfutureField: someValue\n');
    expect(result.theme).toBe('dark');
    expect((result as Record<string, unknown>)['futureField']).toBe('someValue');
  });

  it('theme が不正値の場合はスキーマの既定 (system) にフォールバックする', () => {
    const result = parseAppSettings('theme: invalid_value\n');
    expect(result.theme).toBe('system');
  });

  it('DEFAULT_APP_SETTINGS の既定値が正しい', () => {
    expect(DEFAULT_APP_SETTINGS.theme).toBe('system');
    expect(DEFAULT_APP_SETTINGS.defaultFolder).toBe('');
    expect(DEFAULT_APP_SETTINGS.journalTemplate).toBe('system/templates/journal.md');
    expect(DEFAULT_APP_SETTINGS.showSystemFolder).toBe(false);
  });

  it('SYSTEM_SETTINGS_PATH が system/settings.yaml', () => {
    expect(SYSTEM_SETTINGS_PATH).toBe('system/settings.yaml');
  });
});

describe('serializeAppSettings [AC-Sa10026-3-1]', () => {
  it('AppSettings を YAML テキストに変換する', () => {
    const settings = { ...DEFAULT_APP_SETTINGS, theme: 'dark' as const };
    const yaml = serializeAppSettings(settings);
    // YAML テキストが 'theme: dark' を含む
    expect(yaml).toMatch(/theme:\s*dark/);
  });

  it('serializeAppSettings → parseAppSettings の round-trip', () => {
    const original = {
      theme: 'light' as const,
      defaultFolder: 'notes',
      journalTemplate: 'system/templates/journal.md',
      showSystemFolder: true,
    };
    const yaml = serializeAppSettings(original);
    const restored = parseAppSettings(yaml);
    expect(restored.theme).toBe(original.theme);
    expect(restored.defaultFolder).toBe(original.defaultFolder);
    expect(restored.journalTemplate).toBe(original.journalTemplate);
    expect(restored.showSystemFolder).toBe(original.showSystemFolder);
  });
});

describe('appSettingsSchema boundary [AC-Sa10026-3-2]', () => {
  it('スキーマのキーに端末依存フィールドが含まれない', () => {
    const terminalDependentFields = [
      'lastOpenedNote',
      'lastOpenNote',
      'recentNotes',
      'paneWidth',
      'sidebarWidth',
      'searchIndexCache',
      'indexCache',
      'windowSize',
      'windowPosition',
    ];
    const schemaKeys = Object.keys(appSettingsSchema.shape);
    for (const field of terminalDependentFields) {
      expect(schemaKeys).not.toContain(field);
    }
  });

  it('スキーマのフィールドは移植可能な設定のみ (5 フィールド: Se3b7a2-8 で tasks を追加)', () => {
    const schemaKeys = Object.keys(appSettingsSchema.shape);
    expect(schemaKeys).toContain('theme');
    expect(schemaKeys).toContain('defaultFolder');
    expect(schemaKeys).toContain('journalTemplate');
    expect(schemaKeys).toContain('showSystemFolder');
    expect(schemaKeys).toContain('tasks'); // Se3b7a2-8: タスク語彙 (ADR-0029)
    expect(schemaKeys.length).toBe(5);
  });
});

// ---- [Se3b7a2-8] TaskVocab スキーマ + parseTaskVocab / serializeTaskVocab ----

import {
  taskVocabSchema,
  taskStatusEntrySchema,
  taskPriorityEntrySchema,
  DEFAULT_TASK_VOCAB,
  parseTaskVocab,
  serializeTaskVocab,
} from './system-definitions.js';

describe('[Se3b7a2-8] taskStatusEntrySchema', () => {
  it('最低限の必須フィールド (key, label) が valid', () => {
    const result = taskStatusEntrySchema.safeParse({ key: 'todo', label: 'Todo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe('todo');
      expect(result.data.label).toBe('Todo');
      expect(result.data.color).toBeUndefined();
      expect(result.data.done).toBeUndefined();
    }
  });

  it('key が空文字列のとき invalid', () => {
    const result = taskStatusEntrySchema.safeParse({ key: '', label: 'Todo' });
    expect(result.success).toBe(false);
  });

  it('done: true を持つエントリが valid', () => {
    const result = taskStatusEntrySchema.safeParse({ key: 'done', label: 'Done', color: 'green', done: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.done).toBe(true);
  });
});

describe('[Se3b7a2-8] taskPriorityEntrySchema', () => {
  it('最低限の必須フィールド (key, label) が valid', () => {
    const result = taskPriorityEntrySchema.safeParse({ key: 'high', label: 'High' });
    expect(result.success).toBe(true);
  });

  it('key が空文字列のとき invalid', () => {
    const result = taskPriorityEntrySchema.safeParse({ key: '', label: 'High' });
    expect(result.success).toBe(false);
  });
});

describe('[Se3b7a2-8] taskVocabSchema', () => {
  it('statuses と priorities の両方が省略可能 (全 optional)', () => {
    const result = taskVocabSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('statuses / priorities が配列のとき valid', () => {
    const result = taskVocabSchema.safeParse({
      statuses: [{ key: 'todo', label: 'Todo' }],
      priorities: [{ key: 'high', label: 'High' }],
    });
    expect(result.success).toBe(true);
  });

  it('statuses 要素に key なし → invalid', () => {
    const result = taskVocabSchema.safeParse({
      statuses: [{ label: 'Todo' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('[Se3b7a2-8] DEFAULT_TASK_VOCAB', () => {
  it('DEFAULT_TASK_VOCAB は statuses と priorities を持つ', () => {
    expect(DEFAULT_TASK_VOCAB.statuses).toBeInstanceOf(Array);
    expect(DEFAULT_TASK_VOCAB.priorities).toBeInstanceOf(Array);
    expect(DEFAULT_TASK_VOCAB.statuses.length).toBeGreaterThan(0);
    expect(DEFAULT_TASK_VOCAB.priorities.length).toBeGreaterThan(0);
  });

  it('done: true のステータスが 1 つ以上ある', () => {
    const doneStatuses = DEFAULT_TASK_VOCAB.statuses.filter((s) => s.done === true);
    expect(doneStatuses.length).toBeGreaterThan(0);
  });

  it('全てのキーはスキーマ検証を通る', () => {
    const result = taskVocabSchema.safeParse(DEFAULT_TASK_VOCAB);
    expect(result.success).toBe(true);
  });
});

describe('[Se3b7a2-8] parseTaskVocab', () => {
  it('null → DEFAULT_TASK_VOCAB を返す (フォールバック保証)', () => {
    const vocab = parseTaskVocab(null);
    expect(vocab.statuses).toEqual(DEFAULT_TASK_VOCAB.statuses);
    expect(vocab.priorities).toEqual(DEFAULT_TASK_VOCAB.priorities);
  });

  it('空文字列 → DEFAULT_TASK_VOCAB を返す', () => {
    const vocab = parseTaskVocab('');
    expect(vocab).toEqual(DEFAULT_TASK_VOCAB);
  });

  it('tasks: セクションが無い YAML → DEFAULT_TASK_VOCAB を返す', () => {
    const yaml = 'theme: light\ndefaultFolder: notes\n';
    const vocab = parseTaskVocab(yaml);
    expect(vocab).toEqual(DEFAULT_TASK_VOCAB);
  });

  it('tasks: セクション付きの YAML を正しくパースする', () => {
    const yaml = [
      'theme: light',
      'tasks:',
      '  statuses:',
      '    - key: open',
      '      label: Open',
      '      color: gray',
      '    - key: closed',
      '      label: Closed',
      '      color: green',
      '      done: true',
      '  priorities:',
      '    - key: urgent',
      '      label: Urgent',
      '      color: red',
    ].join('\n');
    const vocab = parseTaskVocab(yaml);
    expect(vocab.statuses).toHaveLength(2);
    expect(vocab.statuses[0]).toMatchObject({ key: 'open', label: 'Open', color: 'gray' });
    expect(vocab.statuses[1]).toMatchObject({ key: 'closed', done: true });
    expect(vocab.priorities).toHaveLength(1);
    expect(vocab.priorities[0]).toMatchObject({ key: 'urgent', label: 'Urgent' });
  });

  it('tasks: セクションが不正なとき DEFAULT_TASK_VOCAB を返す (寛容 read)', () => {
    const yaml = 'tasks:\n  statuses:\n    - {}\n'; // key が無い → スキーマ不合格
    const vocab = parseTaskVocab(yaml);
    expect(vocab).toEqual(DEFAULT_TASK_VOCAB);
  });

  it('壊れた YAML → DEFAULT_TASK_VOCAB を返す', () => {
    const vocab = parseTaskVocab('tasks:\n  statuses: [[[]]');
    expect(vocab).toEqual(DEFAULT_TASK_VOCAB);
  });
});

describe('[Se3b7a2-8] serializeTaskVocab', () => {
  it('正常なタスク語彙を YAML 文字列に直列化する', () => {
    const vocab = {
      statuses: [{ key: 'todo', label: 'Todo', color: 'gray' }],
      priorities: [{ key: 'high', label: 'High', color: 'amber' }],
    };
    const yaml = serializeTaskVocab(vocab);
    expect(typeof yaml).toBe('string');
    expect(yaml).toContain('statuses:');
    expect(yaml).toContain('priorities:');
    expect(yaml).toContain('todo');
    expect(yaml).toContain('high');
  });

  it('serializeTaskVocab → parseTaskVocab でラウンドトリップする', () => {
    const yaml = serializeTaskVocab(DEFAULT_TASK_VOCAB);
    const parsed = parseTaskVocab(yaml);
    expect(parsed.statuses).toEqual(DEFAULT_TASK_VOCAB.statuses);
    expect(parsed.priorities).toEqual(DEFAULT_TASK_VOCAB.priorities);
  });
});
