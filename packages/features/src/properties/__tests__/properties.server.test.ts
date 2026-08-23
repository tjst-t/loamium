/** @vitest-environment node */
/**
 * frontmatter プロパティの REST (task #17)。
 * 肝は **1 キーずつ書く**こと: ノート全体を送らないので、別の書き手が足したキーを巻き戻さない。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '@loamium/server/src/app'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>

const NOTE = '---\ntitle: 走り書き\ndone: false\n---\n\n本文。\n'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-props-'))
  await writeFile(join(root, 'a.md'), NOTE)
  await writeFile(join(root, 'b.md'), '---\ntitle: b\n---\n')
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

const put = (body: unknown): Promise<Response> => call('/api/properties', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const read = (name: string): Promise<string> => readFile(join(root, name), 'utf8')

describe('REST: properties', () => {
  it('GET /api/properties は型つきで返す', async () => {
    const body = (await (await call('/api/properties?path=a.md')).json()) as { properties: unknown }
    expect(body.properties).toEqual([
      { key: 'title', type: 'text', value: '走り書き' },
      { key: 'done', type: 'boolean', value: false },
    ])
  })

  it('GET /api/properties/keys は vault 全体のキーを多い順に返す', async () => {
    const body = (await (await call('/api/properties/keys')).json()) as { keys: { key: string; count: number }[] }
    expect(body.keys).toEqual([
      { key: 'title', type: 'text', count: 2 },
      { key: 'done', type: 'boolean', count: 1 },
    ])
  })

  it('PUT は 1 キーだけ書き換え、本文と他の行を残す', async () => {
    expect((await put({ path: 'a.md', key: 'done', type: 'boolean', value: true })).status).toBe(200)
    expect(await read('a.md')).toBe('---\ntitle: 走り書き\ndone: true\n---\n\n本文。\n')
  })

  it('PUT で追加・改名・削除ができる', async () => {
    await put({ path: 'a.md', key: 'count', type: 'number', value: 3 })
    expect(await read('a.md')).toContain('count: 3')
    await put({ path: 'a.md', key: 'count', renameTo: 'ページ数' })
    expect(await read('a.md')).toContain('ページ数: 3')
    await put({ path: 'a.md', key: 'ページ数', remove: true })
    expect(await read('a.md')).not.toContain('ページ数')
  })

  it('path と key は必須', async () => {
    expect((await put({ key: 'x' })).status).toBe(400)
    expect((await put({ path: 'a.md' })).status).toBe(400)
  })

  it('vault の外は触れない (%2e%2e%2f も含む)', async () => {
    expect((await put({ path: '../outside.md', key: 'x', type: 'text', value: 'y' })).status).toBeGreaterThanOrEqual(400)
    expect((await call(`/api/properties?path=${encodeURIComponent('../outside.md')}`)).status).toBeGreaterThanOrEqual(400)
  })
})

describe('エージェントツール', () => {
  it('set_property / remove_property は監査済みサービス層を通る', async () => {
    await ctx.tools.invoke('set_property', { path: 'a.md', key: 'status', value: '進行中' }, ['write'])
    expect(await read('a.md')).toContain('status: 進行中')
    await ctx.tools.invoke('remove_property', { path: 'a.md', key: 'status' }, ['write'])
    expect(await read('a.md')).not.toContain('status')
  })

  it('read だけでは書けない (ADR-0015)', async () => {
    await expect(ctx.tools.invoke('set_property', { path: 'a.md', key: 'x', value: 'y' }, ['read']))
      .rejects.toThrow(/ケーパビリティが不足/)
  })
})
