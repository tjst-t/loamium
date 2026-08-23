/** @vitest-environment node */
/**
 * ブックマーク (task #18 / ADR-0004)。
 * 状態は**ノート自身の frontmatter**。設定ファイルに逃がさないので、ノートと一緒に旅をする。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '@loamium/server/src/app'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>
const put = (body: unknown): Promise<Response> => call('/api/bookmarks', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const list = async (): Promise<{ path: string; title: string }[]> =>
  ((await (await call('/api/bookmarks')).json()) as { bookmarks: { path: string; title: string }[] }).bookmarks

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-bm-'))
  await writeFile(join(root, 'a.md'), '# a\n\n本文。\n')
  await writeFile(join(root, 'b.md'), '---\ntitle: 走り書き\nbookmark: true\n---\n\n本文。\n')
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: bookmarks', () => {
  it('frontmatter に bookmark: true があるノートを返す (title があればそれを出す)', async () => {
    expect(await list()).toEqual([{ path: 'b.md', title: '走り書き' }])
  })

  it('付けると frontmatter が増え、本文は変わらない', async () => {
    expect((await put({ path: 'a.md' })).status).toBe(200)
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('---\nbookmark: true\n---\n# a\n\n本文。\n')
    expect((await list()).map((b) => b.path)).toEqual(['a.md', 'b.md'])
  })

  it('外すときは `bookmark: false` を残さずキーごと消す', async () => {
    await put({ path: 'b.md', bookmark: false })
    const after = await readFile(join(root, 'b.md'), 'utf8')
    expect(after).not.toContain('bookmark')
    expect(after).toContain('title: 走り書き')
    expect(await list()).toEqual([])
  })

  it('path は必須 / vault の外は触れない', async () => {
    expect((await put({})).status).toBe(400)
    expect((await put({ path: '../outside.md' })).status).toBeGreaterThanOrEqual(400)
  })
})

describe('エージェントツール', () => {
  it('set_bookmark は write ケーパビリティが要る (ADR-0015)', async () => {
    await expect(ctx.tools.invoke('set_bookmark', { path: 'a.md' }, ['read']))
      .rejects.toThrow(/ケーパビリティが不足/)
    await ctx.tools.invoke('set_bookmark', { path: 'a.md' }, ['write'])
    expect((await ctx.tools.invoke('list_bookmarks', {}, ['read']) as { bookmarks: unknown[] }).bookmarks)
      .toHaveLength(2)
  })
})
