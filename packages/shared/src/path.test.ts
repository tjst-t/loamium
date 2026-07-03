import { describe, expect, it } from 'vitest';
import { isValidVaultPath, normalizeVaultPath, VaultPathError } from './path.js';

describe('normalizeVaultPath', () => {
  it('appends .md when extension is missing', () => {
    expect(normalizeVaultPath('projects/loamium')).toBe('projects/loamium.md');
  });

  it('keeps .md extension as-is', () => {
    expect(normalizeVaultPath('projects/loamium.md')).toBe('projects/loamium.md');
  });

  it('treats non-md extensions as part of the name (notes API only manages .md)', () => {
    expect(normalizeVaultPath('notes/v1.2')).toBe('notes/v1.2.md');
    expect(normalizeVaultPath('file.txt')).toBe('file.txt.md');
  });

  it('normalizes to NFC (NFD input from macOS)', () => {
    const nfd = 'がき.md'; // が (NFD: か + 濁点)
    const nfc = 'がき.md';
    expect(normalizeVaultPath(nfd)).toBe(nfc);
  });

  it('accepts Japanese paths', () => {
    expect(normalizeVaultPath('日記/メモ')).toBe('日記/メモ.md');
  });

  it('rejects ".." traversal', () => {
    expect(() => normalizeVaultPath('../escape.md')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('a/../../b.md')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('..')).toThrow(VaultPathError);
  });

  it('rejects "." segments', () => {
    expect(() => normalizeVaultPath('./a.md')).toThrow(VaultPathError);
  });

  it('rejects absolute paths', () => {
    expect(() => normalizeVaultPath('/etc/passwd')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('C:/windows')).toThrow(VaultPathError);
  });

  it('rejects hidden segments (.loamium / .git protection)', () => {
    expect(() => normalizeVaultPath('.loamium/audit.log')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('.git/config')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('a/.hidden/b.md')).toThrow(VaultPathError);
  });

  it('rejects empty / backslash / null-byte paths', () => {
    expect(() => normalizeVaultPath('')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('a\\b.md')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('a\0b.md')).toThrow(VaultPathError);
    expect(() => normalizeVaultPath('a//b.md')).toThrow(VaultPathError);
  });

  it('isValidVaultPath mirrors normalizeVaultPath', () => {
    expect(isValidVaultPath('ok/note')).toBe(true);
    expect(isValidVaultPath('../bad')).toBe(false);
  });
});
