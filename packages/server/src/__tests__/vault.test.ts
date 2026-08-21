/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { VaultPathError } from '@loamium/shared'
import '../types'
import { VaultService } from '../plugins/vault'

let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-vault-'))
  ctx = new Context()
  ctx.plugin(VaultService, { root })
  await ctx.inject(['vault'], () => {})
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('VaultService: vault 脱出の防止', () => {
  it.each([
    ['../escaped.md'],
    ['../../escaped.md'],
    ['a/../../escaped.md'],
    ['..\\escaped.md'],
  ])('write は %s を拒否する', async (path) => {
    await expect(ctx.vault.write(path, '# x')).rejects.toThrow(VaultPathError)
  })

  it.each([
    ['../../../etc/hostname'],
    ['..%2f..%2fetc/hostname'.replace(/%2f/g, '/')],
  ])('read は %s を拒否する', async (path) => {
    await expect(ctx.vault.read(path)).rejects.toThrow(VaultPathError)
  })

  it('絶対パスは vault 配下に閉じ込める', async () => {
    await ctx.vault.write('/etc/hostname', '# 乗っ取り')
    expect(await readFile(join(root, 'etc/hostname'), 'utf8')).toContain('乗っ取り')
  })
})

describe('VaultService: 書き込み経路', () => {
  it('.md は normalizeForSave を通る', async () => {
    await ctx.vault.write('t.md', '|a|b|\n|---|---|\n|x||\n')
    expect(await readFile(join(root, 't.md'), 'utf8')).toBe('| a | b |\n| - | - |\n| x | |\n')
  })

  it('.md 以外は素通しする', async () => {
    await ctx.vault.write('data.json', '{"a":1}')
    expect(await readFile(join(root, 'data.json'), 'utf8')).toBe('{"a":1}')
  })

  it('ネストディレクトリを作る', async () => {
    await ctx.vault.write('a/b/c.md', '# deep')
    expect(await readFile(join(root, 'a/b/c.md'), 'utf8')).toBe('# deep\n')
  })

  it('既存ディレクトリへの再書き込みが EEXIST で落ちない (bun on Windows 対策)', async () => {
    await ctx.vault.write('a/b/c.md', '# 1')
    await expect(ctx.vault.write('a/b/d.md', '# 2')).resolves.toBeUndefined()
  })

  it('監査ログに記録する', async () => {
    await ctx.vault.write('t.md', '# x')
    const log = await readFile(join(root, '.loamium/audit.log'), 'utf8')
    const entry = JSON.parse(log.trim()) as { op: string; path: string }
    expect(entry.op).toBe('write')
    expect(entry.path).toBe('t.md')
  })

  it('vault/change イベントが正規化済みパスで飛ぶ', async () => {
    const seen: [string, string][] = []
    ctx.on('vault/change', (p, op) => { seen.push([p, op]) })
    await ctx.vault.write('/a//b.md', '# x')
    expect(seen).toEqual([['a/b.md', 'upsert']])
  })
})

describe('VaultService: list', () => {
  it('.md だけを / 区切りの相対パスで返す', async () => {
    await mkdir(join(root, '日誌'), { recursive: true })
    await writeFile(join(root, '日誌/2026-08-21.md'), '# j')
    await writeFile(join(root, 'note.md'), '# n')
    await writeFile(join(root, 'skip.txt'), 'x')
    expect((await ctx.vault.list()).sort()).toEqual(['note.md', '日誌/2026-08-21.md'])
  })

  it('隠しディレクトリを無視する (.loamium など)', async () => {
    await ctx.vault.write('t.md', '# x') // .loamium/audit.log ができる
    expect(await ctx.vault.list()).toEqual(['t.md'])
  })
})
