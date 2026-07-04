import { describe, expect, it } from 'vitest';
import {
  HiddenVaultPathError,
  isValidVaultPath,
  normalizeVaultFilePath,
  normalizeVaultPath,
  VaultPathError,
} from './path.js';

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

describe('normalizeVaultFilePath (S9e5ca4-2: files API 用)', () => {
  it('.md を補完せず任意拡張子を通す', () => {
    expect(normalizeVaultFilePath('assets/pixel.png')).toBe('assets/pixel.png');
    expect(normalizeVaultFilePath('notes/メモ.md')).toBe('notes/メモ.md');
    expect(normalizeVaultFilePath('data')).toBe('data');
  });

  it('NFC 正規化とセグメント trim は normalizeVaultPath と同じ', () => {
    const nfd = 'ガ'.normalize('NFD');
    expect(normalizeVaultFilePath(`${nfd}.png`)).toBe('ガ.png');
    expect(normalizeVaultFilePath(' assets / a.png ')).toBe('assets/a.png');
  });

  it('traversal / 絶対パス / 空 / バックスラッシュ / null byte は VaultPathError', () => {
    expect(() => normalizeVaultFilePath('../etc/passwd')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('a/../b.png')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('./a.png')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('/etc/passwd')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('C:/windows')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('a\\b.png')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('a\0b.png')).toThrow(VaultPathError);
    expect(() => normalizeVaultFilePath('a//b.png')).toThrow(VaultPathError);
  });

  it('隠しセグメントは HiddenVaultPathError (404 写像用に区別できる)', () => {
    expect(() => normalizeVaultFilePath('.loamium/audit.log')).toThrow(HiddenVaultPathError);
    expect(() => normalizeVaultFilePath('.git/config')).toThrow(HiddenVaultPathError);
    expect(() => normalizeVaultFilePath('a/.hidden/b.png')).toThrow(HiddenVaultPathError);
    // HiddenVaultPathError は VaultPathError の部分型 (既存 catch を壊さない)
    expect(() => normalizeVaultFilePath('.loamium/audit.log')).toThrow(VaultPathError);
    // traversal は Hidden ではなく通常の VaultPathError (400 側)
    expect(() => normalizeVaultFilePath('../x')).not.toThrow(HiddenVaultPathError);
  });
});
