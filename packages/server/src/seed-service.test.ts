/**
 * SeedService のユニットテスト (S7e2d5c-1 / AC-S7e2d5c-1-8)。
 *
 * [AC-S7e2d5c-1-8]
 *   ① 空ディレクトリへの初回投入: 正しいファイル数が投入されること
 *   ② 2 回目の実行 (force=false): seeded=0、skipped=期待ファイル数
 *   ③ force=true: 既存ファイルも上書きされること
 *
 * mkdtemp で一時 vault ディレクトリを作り、テスト後に削除する。
 * 実際の samples/ ではなくインメモリの fixture ファイルを使う (小型・決定論的)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { seed, mapSeedPath } from './seed-service.js';

// ---- テスト用フィクスチャ ----

/** fixtures/ にサンプルファイルを作成して srcRoot として使う */
async function createFixtures(dir: string): Promise<void> {
  const files: [string, string][] = [
    ['commands/todo-add.yaml', 'name: TODO 追加\nsteps: []\n'],
    ['commands/log-memo.yaml', 'name: ログメモ\nsteps: []\n'],
    ['templates/journal.md', '# {{date}} ジャーナル\n'],
    ['templates/議事録.md', '# {{title}} 議事録\n'],
    ['smart-folders/recent.yaml', 'id: recent\nname: 最近の更新\nquery: LIST\n'],
    ['smart-folders/todos.yaml', 'id: todos\nname: 未完了TODO\nquery: LIST\n'],
    ['index.md', '# サンプル集\n'],
    ['機能ガイド/スマートコマンドの使い方.md', '# スマートコマンド\n'],
  ];
  for (const [rel, content] of files) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

// ---- テスト用 vault ----

let vaultRoot: string;
let fixturesRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-seed-test-vault-'));
  fixturesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-seed-test-src-'));
  await createFixtures(fixturesRoot);
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
  await fs.rm(fixturesRoot, { recursive: true, force: true });
});

// ---- mapSeedPath のユニットテスト ----

describe('mapSeedPath', () => {
  it('commands/*.yaml → system/commands/', () => {
    expect(mapSeedPath('commands/todo-add.yaml')).toBe('system/commands/todo-add.yaml');
  });

  it('smart-folders/*.yaml → system/smart-folders/', () => {
    expect(mapSeedPath('smart-folders/recent.yaml')).toBe('system/smart-folders/recent.yaml');
  });

  it('templates/*.md → templates/', () => {
    expect(mapSeedPath('templates/journal.md')).toBe('templates/journal.md');
  });

  it('index.md → samples/index.md', () => {
    expect(mapSeedPath('index.md')).toBe('samples/index.md');
  });

  it('機能ガイド/x.md → samples/機能ガイド/x.md', () => {
    expect(mapSeedPath('機能ガイド/スマートコマンドの使い方.md')).toBe(
      'samples/機能ガイド/スマートコマンドの使い方.md',
    );
  });
});

// ---- seed() のユニットテスト ----

describe('seed()', () => {
  it('[AC-S7e2d5c-1-8-1] 空ディレクトリへの初回投入でファイル数一致', async () => {
    const result = await seed(vaultRoot, false, fixturesRoot);
    // fixtures: 8 ファイル
    expect(result.seeded).toBe(8);
    expect(result.skipped).toBe(0);

    // マッピング先に実際に存在することを確認
    const check = async (rel: string): Promise<void> => {
      const abs = path.join(vaultRoot, rel);
      const stat = await fs.stat(abs);
      expect(stat.isFile()).toBe(true);
    };
    await check('system/commands/todo-add.yaml');
    await check('system/commands/log-memo.yaml');
    await check('templates/journal.md');
    await check('templates/議事録.md');
    await check('system/smart-folders/recent.yaml');
    await check('system/smart-folders/todos.yaml');
    await check('samples/index.md');
    await check('samples/機能ガイド/スマートコマンドの使い方.md');
  });

  it('[AC-S7e2d5c-1-8-2] 2 回目の実行は seeded=0、skipped=ファイル数', async () => {
    await seed(vaultRoot, false, fixturesRoot);
    const result = await seed(vaultRoot, false, fixturesRoot);
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(8);
  });

  it('[AC-S7e2d5c-1-8-3] force=true で既存ファイルを上書き', async () => {
    // 初回投入
    await seed(vaultRoot, false, fixturesRoot);

    // vault 内のファイルを改変
    const targetAbs = path.join(vaultRoot, 'system/commands/todo-add.yaml');
    await fs.writeFile(targetAbs, 'MODIFIED', 'utf8');

    // force=true で再投入
    const result = await seed(vaultRoot, true, fixturesRoot);
    expect(result.seeded).toBe(8);
    expect(result.skipped).toBe(0);

    // 改変されたファイルが元に戻っていること
    const content = await fs.readFile(targetAbs, 'utf8');
    expect(content).not.toBe('MODIFIED');
    expect(content).toContain('TODO');
  });

  it('force=false のとき既存ファイルの内容は変わらない', async () => {
    await seed(vaultRoot, false, fixturesRoot);

    // vault 内のファイルを改変
    const targetAbs = path.join(vaultRoot, 'samples/index.md');
    await fs.writeFile(targetAbs, 'MODIFIED', 'utf8');

    // force=false で再投入
    await seed(vaultRoot, false, fixturesRoot);

    // 改変されたファイルがそのままであること
    const content = await fs.readFile(targetAbs, 'utf8');
    expect(content).toBe('MODIFIED');
  });
});
