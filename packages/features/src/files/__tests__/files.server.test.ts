/** @vitest-environment node */
/**
 * 添付ファイル (task #16)。
 * 肝は **`.md` をこの経路で書かせない**こと (ノートの正規化を迂回させない)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '@loamium/server/src/app'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>

const upload = (path: string, body: string): Promise<Response> =>
  call(`/api/files/${encodeURI(path)}`, { method: 'POST', body })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-files-'))
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'note.md'), '# note\n')
  await writeFile(join(root, 'assets/表.csv'), 'a,b\n1,2\n')
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: files', () => {
  it('GET /api/files は .md 以外を返す', async () => {
    const body = (await (await call('/api/files')).json()) as { files: { path: string }[] }
    expect(body.files.map((f) => f.path)).toEqual(['assets/表.csv'])
  })

  it('POST は assets/ に置き、パスを返す', async () => {
    const r = await upload('assets/図.txt', 'hello')
    expect(await r.json()).toEqual({ path: 'assets/図.txt', size: 5 })
    expect(await readFile(join(root, 'assets/図.txt'), 'utf8')).toBe('hello')
  })

  it('フォルダを書かなければ assets/ に入る', async () => {
    expect(await (await upload('図.txt', 'x')).json()).toMatchObject({ path: 'assets/図.txt' })
  })

  it('同じ名前は上書きせず連番を足す', async () => {
    await upload('assets/図.txt', 'a')
    expect(await (await upload('assets/図.txt', 'b')).json()).toMatchObject({ path: 'assets/図-2.txt' })
    expect(await readFile(join(root, 'assets/図.txt'), 'utf8')).toBe('a')
  })

  it('.md は書けない (ノートの正規化を迂回させない)', async () => {
    expect((await upload('assets/x.md', '# x')).status).toBe(400)
  })

  it('GET /api/files/:path は拡張子から決めた型で配る', async () => {
    const r = await call(`/api/files/${encodeURI('assets/表.csv')}`)
    expect(r.headers.get('content-type')).toBe('text/csv')
    expect(await r.text()).toBe('a,b\n1,2\n')
  })

  it('無いものは 404 / vault の外は触れない', async () => {
    expect((await call('/api/files/assets/none.png')).status).toBe(404)
    expect((await upload('../outside.txt', 'x')).status).toBeGreaterThanOrEqual(400)
  })
})

describe('エージェントツール', () => {
  it('read_file はテキストだけ読める', async () => {
    expect(await ctx.tools.invoke('read_file', { path: 'assets/表.csv' }, ['read']))
      .toEqual({ path: 'assets/表.csv', content: 'a,b\n1,2\n' })
    await upload('assets/図.png', 'binary')
    await expect(ctx.tools.invoke('read_file', { path: 'assets/図.png' }, ['read']))
      .rejects.toThrow(/テキストとして読めません/)
  })

  it('delete_file はノートを消せない', async () => {
    await expect(ctx.tools.invoke('delete_file', { path: 'note.md' }, ['write']))
      .rejects.toThrow(/note_delete/)
    await ctx.tools.invoke('delete_file', { path: 'assets/表.csv' }, ['write'])
    const body = (await (await call('/api/files')).json()) as { files: unknown[] }
    expect(body.files).toEqual([])
  })
})

describe('ツリー', () => {
  it('添付もツリーに出る (見えないと消せない)', async () => {
    const body = (await (await call('/api/tree')).json()) as { tree: { name: string; type: string; children?: { name: string; type: string }[] }[] }
    const assets = body.tree.find((n) => n.name === 'assets')
    expect(assets?.children).toEqual([{ name: '表.csv', path: 'assets/表.csv', type: 'file' }])
  })

  it('DELETE /api/files で消せる。.md は消せない', async () => {
    expect((await call(`/api/files/${encodeURI('assets/表.csv')}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call('/api/files/note.md', { method: 'DELETE' })).status).toBe(400)
  })
})
