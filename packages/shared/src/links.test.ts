import { describe, expect, it } from 'vitest';
import { preferredFileLinkTarget, preferredLinkTarget, resolveFileLinkTarget, resolveLinkTarget } from './links.js';

const vault = [
  'hydra.md',
  'projects/hydra.md',
  'projects/loamium.md',
  'notes/deep/hydra.md',
  'ノート/概要.md',
  'journals/2026-07-03.md',
];

describe('resolveLinkTarget', () => {
  it('resolves a bare filename across folders (shortest path wins)', () => {
    expect(resolveLinkTarget('hydra', vault)).toBe('hydra.md');
  });

  it('resolves with explicit .md extension the same as without', () => {
    expect(resolveLinkTarget('hydra.md', vault)).toBe(resolveLinkTarget('hydra', vault));
  });

  it('resolves a path-qualified target from the vault root', () => {
    expect(resolveLinkTarget('projects/hydra', vault)).toBe('projects/hydra.md');
  });

  it('resolves case-insensitively (Obsidian-compatible)', () => {
    expect(resolveLinkTarget('HYDRA', vault)).toBe('hydra.md');
    expect(resolveLinkTarget('Projects/Loamium', vault)).toBe('projects/loamium.md');
  });

  it('resolves NFD input to the NFC path', () => {
    expect(resolveLinkTarget('概要', vault)).toBe('ノート/概要.md');
    expect(resolveLinkTarget('ノート/概要'.normalize('NFD'), vault)).toBe('ノート/概要.md');
    const paths = ['ペン.md'];
    expect(resolveLinkTarget('ペン'.normalize('NFD'), paths)).toBe('ペン.md');
  });

  it('prefers fewer path segments, then lexicographic order', () => {
    const paths = ['b/x.md', 'a/x.md', 'a/deep/x.md'];
    expect(resolveLinkTarget('x', paths)).toBe('a/x.md');
  });

  it('returns null for a broken link', () => {
    expect(resolveLinkTarget('does-not-exist', vault)).toBeNull();
  });

  it('returns null for an empty target', () => {
    expect(resolveLinkTarget('', vault)).toBeNull();
    expect(resolveLinkTarget('   ', vault)).toBeNull();
  });

  it('treats a leading / as vault-root reference', () => {
    expect(resolveLinkTarget('/projects/hydra', vault)).toBe('projects/hydra.md');
  });

  it('does not fall back to basename matching for path-qualified misses', () => {
    expect(resolveLinkTarget('other/hydra', vault)).toBeNull();
  });
});

describe('preferredLinkTarget', () => {
  const vault = ['projects/hydra.md', 'notes/メモ.md', 'メモ.md', 'ユニーク.md'];

  it('returns the basename when it resolves uniquely to the note', () => {
    expect(preferredLinkTarget('ユニーク.md', vault)).toBe('ユニーク');
    expect(preferredLinkTarget('projects/hydra.md', vault)).toBe('hydra');
  });

  it('returns the full path when the basename resolves to a different note', () => {
    // "メモ" は浅いパス優先で メモ.md に解決されるため、notes/メモ.md はフルパス表記
    expect(preferredLinkTarget('notes/メモ.md', vault)).toBe('notes/メモ');
    expect(preferredLinkTarget('メモ.md', vault)).toBe('メモ');
  });

  it('NFC-normalizes the note path', () => {
    const nfd = 'ユニーク.md'.normalize('NFD');
    expect(preferredLinkTarget(nfd, vault)).toBe('ユニーク');
  });
});

// ---- 添付ファイル (非 .md) のリンク解決 — Sf53ad6-2 ----

const files = [
  'assets/image.png',
  'assets/image-1.png',
  'assets/report.pdf',
  'projects/img/image.png',
  'assets/写真.png',
  'assets/data.csv',
];

describe('resolveFileLinkTarget', () => {
  it('resolves a bare filename across folders (shortest path wins)', () => {
    expect(resolveFileLinkTarget('image.png', files)).toBe('assets/image.png');
    expect(resolveFileLinkTarget('report.pdf', files)).toBe('assets/report.pdf');
  });

  it('resolves a path-qualified target from the vault root', () => {
    expect(resolveFileLinkTarget('projects/img/image.png', files)).toBe('projects/img/image.png');
  });

  it('does not append .md (attachment targets keep their extension)', () => {
    // "image" というファイルは存在しない — image.png には解決しない
    expect(resolveFileLinkTarget('image', files)).toBeNull();
  });

  it('resolves case-insensitively and NFC-normalized', () => {
    expect(resolveFileLinkTarget('IMAGE.PNG', files)).toBe('assets/image.png');
    expect(resolveFileLinkTarget('写真.png'.normalize('NFD'), files)).toBe('assets/写真.png');
  });

  it('strips a leading slash (vault-root explicit form)', () => {
    expect(resolveFileLinkTarget('/assets/data.csv', files)).toBe('assets/data.csv');
  });

  it('returns null for unknown or empty targets', () => {
    expect(resolveFileLinkTarget('missing.png', files)).toBeNull();
    expect(resolveFileLinkTarget('', files)).toBeNull();
    expect(resolveFileLinkTarget('   ', files)).toBeNull();
  });
});

describe('preferredFileLinkTarget', () => {
  it('returns the basename (with extension) when it resolves uniquely', () => {
    expect(preferredFileLinkTarget('assets/report.pdf', files)).toBe('report.pdf');
    expect(preferredFileLinkTarget('assets/image-1.png', files)).toBe('image-1.png');
  });

  it('returns the full path when the basename resolves to a different file', () => {
    // image.png は浅いパス優先で assets/image.png に解決する
    expect(preferredFileLinkTarget('projects/img/image.png', files)).toBe(
      'projects/img/image.png',
    );
    expect(preferredFileLinkTarget('assets/image.png', files)).toBe('image.png');
  });

  it('NFC-normalizes the file path', () => {
    expect(preferredFileLinkTarget('assets/写真.png'.normalize('NFD'), files)).toBe('写真.png');
  });
});
