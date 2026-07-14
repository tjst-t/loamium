/**
 * system-store.ts のユニットテスト (Sa10026-1-2)。
 *
 * 実際のファイルシステムを使う (tmp ディレクトリを vault root として使用)。
 *
 * [AC-Sa10026-1-1] 寛容 read: 壊れた YAML / スキーマ不合格 → フォールバック
 * [AC-Sa10026-1-2] order → ファイル名の安定ソート
 * [AC-Sa10026-1-3] vault 外脱出防止 (traversal ID は VaultPathError)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listSystemSmartFolders,
  readSystemSmartFolder,
  writeSystemSmartFolder,
  deleteSystemSmartFolder,
  systemSmartFolderMtime,
  listSystemCommands,
  readSystemCommandMeta,
  writeSystemCommand,
  readSystemCommandRaw,
  listSystemTemplates,
  readSystemTemplate,
  writeSystemTemplate,
  deleteSystemTemplate,
} from './system-store.js';
import { VaultPathError } from '@loamium/shared';

// ---- テスト用 vault を tmp に作る ----

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-test-'));
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

/** vault 内に相対パスでファイルを書く */
async function writeVault(relPath: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

// ---- SmartFolder ----

describe('listSystemSmartFolders [AC-Sa10026-1-1, AC-Sa10026-1-2]', () => {
  it('system/smart-folders/ が存在しない場合は空配列を返す', async () => {
    const result = await listSystemSmartFolders(vaultRoot);
    expect(result).toEqual([]);
  });

  it('正常な .yaml ファイルを読み込んで返す', async () => {
    await writeVault('system/smart-folders/inbox.yaml', 'query: "LIST"\ntitle: "受信箱"\n');
    const result = await listSystemSmartFolders(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('inbox');
    expect(result[0]?.title).toBe('受信箱');
    expect(result[0]?.query).toBe('LIST');
  });

  it('複数ファイルを order → ファイル名の安定ソートで返す [AC-Sa10026-1-2]', async () => {
    await writeVault(
      'system/smart-folders/z-last.yaml',
      'query: "LIST"\norder: 10\n',
    );
    await writeVault(
      'system/smart-folders/a-first.yaml',
      'query: "LIST"\norder: 1\n',
    );
    await writeVault(
      'system/smart-folders/m-mid.yaml',
      'query: "LIST"\norder: 5\n',
    );
    const result = await listSystemSmartFolders(vaultRoot);
    expect(result.map((r) => r.id)).toEqual(['a-first', 'm-mid', 'z-last']);
  });

  it('order なしは末尾に来る [AC-Sa10026-1-2]', async () => {
    await writeVault(
      'system/smart-folders/has-order.yaml',
      'query: "LIST"\norder: 1\n',
    );
    await writeVault(
      'system/smart-folders/no-order.yaml',
      'query: "LIST"\n',
    );
    const result = await listSystemSmartFolders(vaultRoot);
    expect(result[0]?.id).toBe('has-order');
    expect(result[1]?.id).toBe('no-order');
  });

  it('query フィールドがない (不正) ファイルはスキップする [AC-Sa10026-1-1]', async () => {
    await writeVault('system/smart-folders/valid.yaml', 'query: "LIST"\n');
    await writeVault('system/smart-folders/invalid.yaml', 'title: "クエリなし"\n');
    const result = await listSystemSmartFolders(vaultRoot);
    // invalid.yaml はスキップされ valid.yaml のみ残る
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('valid');
  });

  it('壊れた YAML ファイルはスキップする [AC-Sa10026-1-1]', async () => {
    await writeVault('system/smart-folders/valid.yaml', 'query: "LIST"\n');
    await writeVault('system/smart-folders/broken.yaml', ': not valid yaml at all');
    const result = await listSystemSmartFolders(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('valid');
  });

  it('.md ファイルは含まない (YAML のみ)', async () => {
    await writeVault('system/smart-folders/note.md', '# not yaml');
    await writeVault('system/smart-folders/actual.yaml', 'query: "LIST"\n');
    const result = await listSystemSmartFolders(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('actual');
  });
});

describe('readSystemSmartFolder [AC-Sa10026-1-1, AC-Sa10026-1-3]', () => {
  it('存在するファイルを読み込んで SmartFolderDef を返す', async () => {
    await writeVault(
      'system/smart-folders/tasks.yaml',
      'title: "タスク"\norder: 1\nquery: "LIST from \\"todos\\""\n',
    );
    const def = await readSystemSmartFolder(vaultRoot, 'tasks');
    expect(def).not.toBeNull();
    expect(def?.id).toBe('tasks');
    expect(def?.title).toBe('タスク');
    expect(def?.query).toBe('LIST from "todos"');
  });

  it('存在しない ID → null', async () => {
    const def = await readSystemSmartFolder(vaultRoot, 'nonexistent');
    expect(def).toBeNull();
  });

  it('traversal ID (../etc) → null [AC-Sa10026-1-3]', async () => {
    const def = await readSystemSmartFolder(vaultRoot, '../etc/passwd');
    expect(def).toBeNull();
  });
});

describe('writeSystemSmartFolder + deleteSystemSmartFolder', () => {
  it('ファイルを書き込み、読み込み、削除できる', async () => {
    const content = 'query: "LIST"\ntitle: "新規"\n';
    const { created } = await writeSystemSmartFolder(vaultRoot, 'new-folder', content);
    expect(created).toBe(true);

    const def = await readSystemSmartFolder(vaultRoot, 'new-folder');
    expect(def?.title).toBe('新規');

    const deleted = await deleteSystemSmartFolder(vaultRoot, 'new-folder');
    expect(deleted).toBe(true);

    const afterDel = await readSystemSmartFolder(vaultRoot, 'new-folder');
    expect(afterDel).toBeNull();
  });

  it('2 回目の書き込みは created: false', async () => {
    await writeSystemSmartFolder(vaultRoot, 'existing', 'query: "LIST"\n');
    const { created } = await writeSystemSmartFolder(vaultRoot, 'existing', 'query: "TABLE"\n');
    expect(created).toBe(false);
  });

  it('存在しない ID を削除すると false を返す', async () => {
    const deleted = await deleteSystemSmartFolder(vaultRoot, 'ghost');
    expect(deleted).toBe(false);
  });

  it('traversal ID への書き込みは VaultPathError を投げる [AC-Sa10026-1-3]', async () => {
    await expect(
      writeSystemSmartFolder(vaultRoot, '../../../etc/passwd', 'query: "LIST"\n'),
    ).rejects.toThrow(VaultPathError);
  });
});

describe('systemSmartFolderMtime', () => {
  it('存在するファイルの mtime を返す', async () => {
    await writeVault('system/smart-folders/x.yaml', 'query: "LIST"\n');
    const mtime = await systemSmartFolderMtime(vaultRoot, 'x');
    expect(typeof mtime).toBe('number');
    expect(mtime).toBeGreaterThan(0);
  });

  it('存在しない ID → null', async () => {
    const mtime = await systemSmartFolderMtime(vaultRoot, 'ghost');
    expect(mtime).toBeNull();
  });
});

// ---- Command ----

describe('listSystemCommands [AC-Sa10026-1-1, AC-Sa10026-1-2]', () => {
  it('system/commands/ が存在しない場合は空配列を返す', async () => {
    const result = await listSystemCommands(vaultRoot);
    expect(result).toEqual([]);
  });

  it('正常な .yaml ファイルを読み込んで返す', async () => {
    const yaml = 'title: "メモ作成"\norder: 1\nname: create-memo\nsteps: []\n';
    await writeVault('system/commands/create-memo.yaml', yaml);
    const result = await listSystemCommands(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('create-memo');
    expect(result[0]?.title).toBe('メモ作成');
    expect(result[0]?.order).toBe(1);
  });

  it('複数ファイルを order → ファイル名の安定ソートで返す [AC-Sa10026-1-2]', async () => {
    await writeVault('system/commands/c-cmd.yaml', 'order: 2\n');
    await writeVault('system/commands/a-cmd.yaml', 'order: 1\n');
    await writeVault('system/commands/b-cmd.yaml', 'order: 2\n');
    const result = await listSystemCommands(vaultRoot);
    // order 1 が先、order 2 はファイル名 (id) 昇順
    expect(result.map((r) => r.id)).toEqual(['a-cmd', 'b-cmd', 'c-cmd']);
  });

  it('壊れた YAML でも id = stem、title = stem のメタ情報を返す [AC-Sa10026-1-1]', async () => {
    await writeVault('system/commands/broken-cmd.yaml', ': bad yaml');
    const result = await listSystemCommands(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('broken-cmd');
    expect(result[0]?.title).toBe('broken-cmd');
    expect(result[0]?.order).toBeUndefined();
  });
});

describe('readSystemCommandRaw + writeSystemCommand', () => {
  it('書き込んだ生テキストをそのまま読み返せる', async () => {
    const content = 'name: test\nsteps: []\n';
    await writeSystemCommand(vaultRoot, 'test-cmd', content);
    const raw = await readSystemCommandRaw(vaultRoot, 'test-cmd');
    expect(raw).not.toBeNull();
    // LF 正規化されているため、内容は同一 (LF のみ)
    expect(raw?.content.replace(/\r\n/g, '\n')).toBe(content);
    expect(typeof raw?.mtime).toBe('number');
  });

  it('存在しない ID → null', async () => {
    const raw = await readSystemCommandRaw(vaultRoot, 'ghost');
    expect(raw).toBeNull();
  });
});

describe('readSystemCommandMeta', () => {
  it('存在するコマンドのメタ情報を返す', async () => {
    await writeVault('system/commands/hello.yaml', 'title: "挨拶"\norder: 3\n');
    const meta = await readSystemCommandMeta(vaultRoot, 'hello');
    expect(meta?.id).toBe('hello');
    expect(meta?.title).toBe('挨拶');
    expect(meta?.order).toBe(3);
  });

  it('存在しない ID → null', async () => {
    const meta = await readSystemCommandMeta(vaultRoot, 'ghost');
    expect(meta).toBeNull();
  });

  it('traversal ID → null [AC-Sa10026-1-3]', async () => {
    const meta = await readSystemCommandMeta(vaultRoot, '../secret');
    expect(meta).toBeNull();
  });
});

// ---- Template ----

describe('listSystemTemplates [AC-Sa10026-1-1, AC-Sa10026-1-2]', () => {
  it('system/templates/ が存在しない場合は空配列を返す', async () => {
    const result = await listSystemTemplates(vaultRoot);
    expect(result).toEqual([]);
  });

  it('frontmatter を持つ .md ファイルを読み込んで返す', async () => {
    const md = `---\ntitle: "週次"\norder: 2\n---\n# 週次レビュー\n`;
    await writeVault('system/templates/weekly.md', md);
    const result = await listSystemTemplates(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('weekly');
    expect(result[0]?.title).toBe('週次');
    expect(result[0]?.order).toBe(2);
  });

  it('複数ファイルを order → ファイル名の安定ソートで返す [AC-Sa10026-1-2]', async () => {
    await writeVault('system/templates/c.md', '---\norder: 10\n---\n');
    await writeVault('system/templates/a.md', '---\norder: 1\n---\n');
    await writeVault('system/templates/b.md', '---\norder: 5\n---\n');
    const result = await listSystemTemplates(vaultRoot);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('frontmatter なし .md は title = stem のフォールバックを返す [AC-Sa10026-1-1]', async () => {
    await writeVault('system/templates/plain.md', '# テンプレート本文\n');
    const result = await listSystemTemplates(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('plain');
    expect(result[0]?.title).toBe('plain');
    expect(result[0]?.order).toBeUndefined();
  });

  it('.yaml ファイルは含まない (.md のみ)', async () => {
    await writeVault('system/templates/notmd.yaml', 'query: "LIST"\n');
    await writeVault('system/templates/actual.md', '# 本物\n');
    const result = await listSystemTemplates(vaultRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('actual');
  });
});

describe('readSystemTemplate + writeSystemTemplate + deleteSystemTemplate', () => {
  it('ファイルを書き込み、読み込み、削除できる', async () => {
    const content = '---\ntitle: "テスト"\n---\n# テスト\n';
    const { created } = await writeSystemTemplate(vaultRoot, 'test-tmpl', content);
    expect(created).toBe(true);

    const result = await readSystemTemplate(vaultRoot, 'test-tmpl');
    expect(result).not.toBeNull();
    expect(result?.def.title).toBe('テスト');
    // content は LF 正規化されて返る
    expect(result?.content).toContain('# テスト');

    const deleted = await deleteSystemTemplate(vaultRoot, 'test-tmpl');
    expect(deleted).toBe(true);

    const afterDel = await readSystemTemplate(vaultRoot, 'test-tmpl');
    expect(afterDel).toBeNull();
  });

  it('traversal ID への書き込みは VaultPathError を投げる [AC-Sa10026-1-3]', async () => {
    await expect(
      writeSystemTemplate(vaultRoot, '../../../etc/passwd', '# bad'),
    ).rejects.toThrow(VaultPathError);
  });

  it('存在しない ID を削除すると false を返す', async () => {
    const deleted = await deleteSystemTemplate(vaultRoot, 'nonexistent');
    expect(deleted).toBe(false);
  });
});
