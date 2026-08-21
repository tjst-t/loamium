/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { normalizeVaultPath, resolveVaultPath, VaultPathError } from '../vault-path'

describe('normalizeVaultPath', () => {
  it('通常のパスはそのまま', () => {
    expect(normalizeVaultPath('機能ガイド/テーブル.md')).toBe('機能ガイド/テーブル.md')
  })
  it('先頭の / と重複スラッシュを畳む', () => {
    expect(normalizeVaultPath('/a//b.md')).toBe('a/b.md')
  })
  it('. を畳む', () => {
    expect(normalizeVaultPath('./a/./b.md')).toBe('a/b.md')
  })
  it('バックスラッシュを / に寄せる', () => {
    expect(normalizeVaultPath('a\\b.md')).toBe('a/b.md')
  })
  it('NFC 正規化する', () => {
    // "が" の分解形 (か + 濁点) を合成形へ
    const decomposed = 'が.md'
    expect(normalizeVaultPath(decomposed)).toBe('が.md')
  })

  it.each([
    ['../escaped.md'],
    ['a/../../escaped.md'],
    ['/../escaped.md'],
    ['a\\..\\..\\escaped.md'],
  ])('.. を拒否する: %s', (p) => {
    expect(() => normalizeVaultPath(p)).toThrow(VaultPathError)
  })

  it('NUL を拒否する', () => {
    expect(() => normalizeVaultPath('a\0.md')).toThrow(VaultPathError)
  })
  it('空パスを拒否する', () => {
    expect(() => normalizeVaultPath('/')).toThrow(VaultPathError)
  })
})

describe('resolveVaultPath', () => {
  const ROOT = '/tmp/loamium-test-vault'

  it('ルート配下に解決する', () => {
    expect(resolveVaultPath(ROOT, 'a/b.md')).toBe(`${ROOT}/a/b.md`)
  })
  it('絶対パスを渡されてもルート配下に閉じ込める', () => {
    expect(resolveVaultPath(ROOT, '/etc/hostname')).toBe(`${ROOT}/etc/hostname`)
  })

  it.each([
    ['../../etc/hostname'],
    ['%2e%2e/x.md'.replace(/%2e/g, '.')], // URL デコード後の形
  ])('脱出を拒否する: %s', (p) => {
    expect(() => resolveVaultPath(ROOT, p)).toThrow(VaultPathError)
  })
})
