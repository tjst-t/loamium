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

describe('VaultService: ツリーと基本操作', () => {
  it('tree はフォルダ先・名前順で、空フォルダも残す', async () => {
    await ctx.vault.write('b.md', '# b')
    await ctx.vault.createFolder('空')
    await ctx.vault.write('あ/c.md', '# c')
    expect(await ctx.vault.tree()).toEqual([
      { name: 'あ', path: 'あ', type: 'folder', children: [{ name: 'c.md', path: 'あ/c.md', type: 'note' }] },
      { name: '空', path: '空', type: 'folder', children: [] },
      { name: 'b.md', path: 'b.md', type: 'note' },
    ])
  })

  it('create は既存を上書きしない', async () => {
    await ctx.vault.create('a.md', '# 元')
    await expect(ctx.vault.create('a.md', '# 別')).rejects.toThrow(/すでに存在します/)
    expect(await ctx.vault.read('a.md')).toBe('# 元\n')
  })

  it('フォルダ移動は配下のノート分だけ remove+upsert を撒く', async () => {
    await ctx.vault.write('src/a.md', '# a')
    await ctx.vault.write('src/nest/b.md', '# b')
    const seen: [string, string][] = []
    ctx.on('vault/change', (p, op) => { seen.push([p, op]) })
    await ctx.vault.move('src', 'dst')
    expect(seen.sort()).toEqual([
      ['dst/a.md', 'upsert'], ['dst/nest/b.md', 'upsert'],
      ['src/a.md', 'remove'], ['src/nest/b.md', 'remove'],
    ])
  })

  it('フォルダを自分の中へは移動できない', async () => {
    await ctx.vault.write('src/a.md', '# a')
    await expect(ctx.vault.move('src', 'src/nest')).rejects.toThrow(/自分の中には移動できません/)
  })

  it('存在しないものの削除は VaultNotFoundError', async () => {
    await expect(ctx.vault.remove('nope.md')).rejects.toThrow(/存在しません/)
  })

  it('移動・削除も監査ログに残る', async () => {
    await ctx.vault.write('a.md', '# a')
    await ctx.vault.move('a.md', 'b.md')
    await ctx.vault.remove('b.md')
    const log = await readFile(join(root, '.loamium/audit.log'), 'utf8')
    expect(log).toContain('"op":"move"')
    expect(log).toContain('"op":"remove"')
  })
})
