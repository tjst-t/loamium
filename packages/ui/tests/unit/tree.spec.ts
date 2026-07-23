/**
 * tree.ts の collectFolderPaths ユニットテスト。
 * 「すべて折りたたむ」で collapsedFolders に投入する全フォルダパス (祖先込み) を検証する。
 */
import { describe, expect, it } from 'vitest';
import type { NoteMeta } from '@loamium/shared';
import { collectFolderPaths } from '../../src/tree.js';

const note = (path: string, folder: string): NoteMeta => ({
  path,
  title: path,
  tags: [],
  folder,
});

describe('collectFolderPaths', () => {
  it('各ノートの folder とその全祖先を列挙する', () => {
    const notes = [
      note('projects/hydra/design.md', 'projects/hydra'),
      note('journals/2026/07/2026-07-22.md', 'journals/2026/07'),
      note('top.md', ''),
    ];
    const got = new Set(collectFolderPaths(notes, []));
    expect(got).toEqual(
      new Set(['projects', 'projects/hydra', 'journals', 'journals/2026', 'journals/2026/07']),
    );
    // ルート直下 ("" folder) はフォルダを生まない
    expect(got.has('')).toBe(false);
  });

  it('extraFolders (未実体の空フォルダ) も祖先込みで含める', () => {
    const got = new Set(collectFolderPaths([], ['a/b/c']));
    expect(got).toEqual(new Set(['a', 'a/b', 'a/b/c']));
  });

  it('重複は 1 つにまとめる', () => {
    const notes = [note('a/x.md', 'a'), note('a/y.md', 'a')];
    expect(collectFolderPaths(notes, []).filter((p) => p === 'a')).toHaveLength(1);
  });
});
