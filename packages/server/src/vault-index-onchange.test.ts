/**
 * VaultIndex.setOnChange ユニットテスト (Sd5c9f4-2)。
 *
 * AC-Sd5c9f4-2-2: refreshFile 完了後 cb が vault 相対パスと 'upsert' で呼ばれる。
 * AC-Sd5c9f4-2-2: removeFile 完了後 cb が vault 相対パスと 'delete' で呼ばれる。
 * AC-Sd5c9f4-2-4: cb の例外はキャッチして stderr に記録し、refreshFile/removeFile を壊さない。
 * indexSyncMiddleware 経由のキャッシュ無効化統合ケース (AC-Sd5c9f4-2-3):
 *   refreshFile を直接呼んでも onChange が発火することを確認 (indexSync は refreshFile を呼ぶ)。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { VaultIndex } from './noteIndex.js';
import { DqlQueryCache, computeQueryHash } from './dql-cache.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'loamium-onchange-test-'));
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

async function writeNote(rel: string, content: string): Promise<string> {
  const abs = path.join(vaultRoot, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  return rel;
}

describe('VaultIndex.setOnChange', () => {
  // ---- refreshFile 後に 'upsert' で呼ばれる [AC-Sd5c9f4-2-2] ----------

  it('refreshFile 後に cb が (rel, upsert) で呼ばれる', async () => {
    const index = new VaultIndex(vaultRoot);
    const calls: [string, string][] = [];
    index.setOnChange((p, op) => { calls.push([p, op]); });

    await writeNote('a.md', '# A\n');
    await index.refreshFile('a.md');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['a.md', 'upsert']);
  });

  it("refreshFile でファイルが存在しない (→ 内部で removeFile) → delete で呼ばれる", async () => {
    // まずインデックスにエントリを追加する
    const index = new VaultIndex(vaultRoot);
    await writeNote('b.md', '# B\n');
    await index.refreshFile('b.md');

    const calls: [string, string][] = [];
    index.setOnChange((p, op) => { calls.push([p, op]); });

    // ファイルが存在しない状態で refreshFile → 内部で removeFile が呼ばれる
    // (ファイルを消してから呼ぶ)
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(path.join(vaultRoot, 'b.md'));
    await index.refreshFile('b.md');

    // removeFile は notes.delete() が true のときのみ cb を呼ぶ
    expect(calls.some(([, op]) => op === 'delete')).toBe(true);
  });

  // ---- removeFile 後に 'delete' で呼ばれる [AC-Sd5c9f4-2-2] -----------

  it('removeFile 後に cb が (rel, delete) で呼ばれる', async () => {
    const index = new VaultIndex(vaultRoot);
    await writeNote('c.md', '# C\n');
    await index.refreshFile('c.md');

    const calls: [string, string][] = [];
    index.setOnChange((p, op) => { calls.push([p, op]); });

    index.removeFile('c.md');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['c.md', 'delete']);
  });

  it('removeFile は存在しないエントリに対して cb を呼ばない', () => {
    const index = new VaultIndex(vaultRoot);
    const calls: [string, string][] = [];
    index.setOnChange((p, op) => { calls.push([p, op]); });

    index.removeFile('no-such.md');

    expect(calls).toHaveLength(0);
  });

  // ---- cb の例外 [AC-Sd5c9f4-2-4] ----------------------------------------

  it('cb が例外を投げてもrefreshFile は正常完了し、インデックスは更新される', async () => {
    const index = new VaultIndex(vaultRoot);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    index.setOnChange(() => {
      throw new Error('callback error!');
    });

    await writeNote('d.md', '# D\n');
    // 例外があっても throw されない
    await expect(index.refreshFile('d.md')).resolves.toBeUndefined();
    // インデックスは更新されている
    expect(index.listNotes()).toHaveLength(1);
    // console.error が呼ばれた
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('VaultIndex.onChange'),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('cb が例外を投げてもremoveFile は正常完了し、インデックスから除去される', async () => {
    const index = new VaultIndex(vaultRoot);
    await writeNote('e.md', '# E\n');
    await index.refreshFile('e.md');
    expect(index.listNotes()).toHaveLength(1);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    index.setOnChange(() => {
      throw new Error('callback error on delete!');
    });

    index.removeFile('e.md');
    // インデックスから除去されている
    expect(index.listNotes()).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // ---- DqlQueryCache 統合 (AC-Sd5c9f4-2-3 / onChange → invalidate) -----

  it('onChange 経由でキャッシュが無効化される (indexSync が refreshFile を呼ぶパスの検証)', async () => {
    const index = new VaultIndex(vaultRoot);
    const cache = new DqlQueryCache();
    const invalidatedIds: string[] = [];

    // onChange で cache.invalidate を呼ぶ (index.ts と同じパターン)
    index.setOnChange((changedPath) => {
      const ids = cache.invalidate(changedPath);
      invalidatedIds.push(...ids);
    });

    await writeNote('f.md', '# F\n');
    await index.refreshFile('f.md');

    // キャッシュに f.md を deps とするエントリを追加
    const hash = computeQueryHash('LIST FROM #tag');
    cache.set('sf-x', [], new Set(['f.md']), hash);
    expect(cache.size).toBe(1);

    // 再度 refreshFile → onChange → cache.invalidate('f.md')
    await index.refreshFile('f.md');
    expect(cache.size).toBe(0);
    expect(invalidatedIds).toContain('sf-x');
  });
});
