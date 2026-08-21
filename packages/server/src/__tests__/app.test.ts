/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '../app'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-app-'))
  await mkdir(join(root, '日誌'), { recursive: true })
  await writeFile(join(root, 'table.md'), '|a|b|\n|---|---|\n|x|y|\n')
  await writeFile(join(root, 'ok.md'), '# ok\n')
  await writeFile(join(root, '日誌/list.md'), '-   ゆるい\n')
  // port 0 = OS 任せ。テストは http.fetch を直接叩くのでポートは使わない
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: notes', () => {
  it('GET /api/health', async () => {
    expect(await (await call('/api/health')).json()).toMatchObject({ ok: true, notes: 3 })
  })

  it('GET /api/notes', async () => {
    const body = (await (await call('/api/notes')).json()) as { paths: string[] }
    expect(body.paths.sort()).toEqual(['ok.md', 'table.md', '日誌/list.md'])
  })

  it('GET /api/notes/:path で日本語パスが読める', async () => {
    const r = await call(`/api/notes/${encodeURI('日誌/list.md')}`)
    expect(await r.text()).toBe('-   ゆるい\n')
  })

  it('存在しないノートは 404', async () => {
    expect((await call('/api/notes/nope.md')).status).toBe(404)
  })

  it('URL エンコードした .. は 400 (vault 脱出の防止)', async () => {
    const r = await call('/api/notes/%2e%2e%2f%2e%2e%2fetc%2fhostname')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'invalid_path' })
  })

  it('POST は normalizeForSave を通す', async () => {
    await call('/api/notes/new.md', { method: 'POST', body: '|a|b|\n|---|---|\n|x||\n' })
    expect(await readFile(join(root, 'new.md'), 'utf8')).toBe('| a | b |\n| - | - |\n| x | |\n')
  })
})

describe('REST: fmt', () => {
  it('dry-run はファイルを書き換えない', async () => {
    const before = await readFile(join(root, 'table.md'), 'utf8')
    const body = (await (await call('/api/vault/fmt?dry-run=1', { method: 'POST' })).json()) as
      { scanned: number; changed: string[]; dryRun: boolean }
    expect(body.dryRun).toBe(true)
    expect(body.scanned).toBe(3)
    expect(body.changed.sort()).toEqual(['table.md', '日誌/list.md'])
    expect(await readFile(join(root, 'table.md'), 'utf8')).toBe(before)
  })

  it('実行すると正規化され、二度目は変化なし (冪等)', async () => {
    const first = (await (await call('/api/vault/fmt', { method: 'POST' })).json()) as { changed: string[] }
    expect(first.changed).toHaveLength(2)
    expect(await readFile(join(root, 'table.md'), 'utf8')).toBe('| a | b |\n| - | - |\n| x | y |\n')

    const second = (await (await call('/api/vault/fmt', { method: 'POST' })).json()) as { changed: string[] }
    expect(second.changed).toEqual([])
  })
})

describe('REST: agent', () => {
  it('全機能のツールが登録されている', async () => {
    const body = (await (await call('/api/agent/tools')).json()) as { tools: { name: string }[] }
    expect(body.tools.map((t) => t.name).sort()).toEqual(
      ['fmt_vault', 'help', 'list_notes', 'read_note', 'write_note'],
    )
  })

  it('ケーパビリティで絞れる (ADR-0015)', async () => {
    const body = (await (await call('/api/agent/tools?capability=read')).json()) as { tools: { name: string }[] }
    expect(body.tools.map((t) => t.name).sort()).toEqual(['help', 'list_notes', 'read_note'])
  })

  it('help トピックが機能ごとに登録されている (ADR-0014)', async () => {
    const body = (await (await call('/api/agent/help')).json()) as { topics: string[] }
    expect(body.topics.sort()).toEqual(['fmt', 'help', 'notes'])
  })

  it('help 本文はピュア Markdown で返る', async () => {
    expect(await (await call('/api/agent/help/fmt')).text()).toContain('# vault の正規化')
  })
})

describe('ツールの実行はケーパビリティで守られる', () => {
  it('write ケーパビリティが無ければ write_note は拒否される', async () => {
    await expect(ctx.tools.invoke('write_note', { path: 'x.md', content: '# x' }, ['read']))
      .rejects.toThrow(/ケーパビリティが不足/)
  })

  it('granted されていれば実行できる', async () => {
    await ctx.tools.invoke('write_note', { path: 'x.md', content: '# x' }, ['read', 'write'])
    expect(await readFile(join(root, 'x.md'), 'utf8')).toBe('# x\n')
  })

  it('ツールは監査済みサービス層を経由する (ADR-0016)', async () => {
    await ctx.tools.invoke('write_note', { path: 'x.md', content: '# x' }, ['write'])
    expect(await readFile(join(root, '.loamium/audit.log'), 'utf8')).toContain('"path":"x.md"')
  })

  it('ツール経由でも vault 脱出は拒否される', async () => {
    await expect(ctx.tools.invoke('read_note', { path: '../../etc/hostname' }, ['read']))
      .rejects.toThrow(/vault の外/)
  })
})
