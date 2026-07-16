/**
 * model-paths.ts のユニットテスト (S8a3f2e-1 / AC-S8a3f2e-1-4)。
 *
 * `.loamium/models/{llm,asr}/` の種別サブフォルダ一元化と、初回アクセス時の
 * ディレクトリ作成、ファイル列挙 (ドット始まり / ディレクトリ除外) を検証する。
 * 実 FS を tmp vault で使う (既存 settings-store.test.ts と同じ流儀)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  modelsRoot,
  modelKindDir,
  modelFilePath,
  ensureModelKindDir,
  listModelFiles,
} from './model-paths.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loamium-model-paths-test-'));
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('model-paths (純粋パス計算)', () => {
  it('種別サブフォルダを .loamium/models/{llm,asr} に分ける', () => {
    expect(modelsRoot(vaultRoot)).toBe(path.join(vaultRoot, '.loamium', 'models'));
    expect(modelKindDir(vaultRoot, 'llm')).toBe(
      path.join(vaultRoot, '.loamium', 'models', 'llm'),
    );
    expect(modelKindDir(vaultRoot, 'asr')).toBe(
      path.join(vaultRoot, '.loamium', 'models', 'asr'),
    );
  });

  it('modelFilePath は種別サブフォルダ配下を指す', () => {
    expect(modelFilePath(vaultRoot, 'llm', 'qwen.gguf')).toBe(
      path.join(vaultRoot, '.loamium', 'models', 'llm', 'qwen.gguf'),
    );
    expect(modelFilePath(vaultRoot, 'asr', 'whisper.bin')).toBe(
      path.join(vaultRoot, '.loamium', 'models', 'asr', 'whisper.bin'),
    );
  });
});

describe('ensureModelKindDir (初回アクセス時作成)', () => {
  it('不在なら作成し、既存でも冪等に成功する', async () => {
    const dir = await ensureModelKindDir(vaultRoot, 'llm');
    expect(dir).toBe(modelKindDir(vaultRoot, 'llm'));
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    // 2 回目もエラーにならない (冪等)。
    await expect(ensureModelKindDir(vaultRoot, 'llm')).resolves.toBe(dir);
  });

  it('llm と asr は別ディレクトリとして共存する', async () => {
    await ensureModelKindDir(vaultRoot, 'llm');
    await ensureModelKindDir(vaultRoot, 'asr');
    const entries = await fs.readdir(modelsRoot(vaultRoot));
    expect(entries.sort()).toEqual(['asr', 'llm']);
  });
});

describe('listModelFiles', () => {
  it('ディレクトリ不在なら空配列 (作成しない)', async () => {
    expect(await listModelFiles(vaultRoot, 'llm')).toEqual([]);
    // 列挙は副作用を持たない: ディレクトリは作られていない。
    await expect(fs.stat(modelKindDir(vaultRoot, 'llm'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('ファイルのみをソートして返し、ドット始まり/ディレクトリは除外する', async () => {
    const dir = await ensureModelKindDir(vaultRoot, 'llm');
    await fs.writeFile(path.join(dir, 'b-model.gguf'), 'x');
    await fs.writeFile(path.join(dir, 'a-model.gguf'), 'x');
    await fs.writeFile(path.join(dir, '.hidden'), 'x');
    await fs.mkdir(path.join(dir, 'subdir'));

    expect(await listModelFiles(vaultRoot, 'llm')).toEqual(['a-model.gguf', 'b-model.gguf']);
  });
});
