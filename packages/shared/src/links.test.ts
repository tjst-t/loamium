import { describe, expect, it } from 'vitest';
import { preferredLinkTarget, resolveLinkTarget } from './links.js';

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
