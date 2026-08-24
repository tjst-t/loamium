/** @vitest-environment node */
/**
 * スマートフォルダ (task #25 / ADR-0001)。
 * 定義は **vault の中の普通の YAML**。中身は dataview と同じクエリ (仕組みを二重に持たない)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '@loamium/server/src/app'
import type { SmartFolder, SmartFolderResult } from '../contract'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>
const post = (body: unknown): Promise<Response> => call('/api/smart-folders', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-sf-'))
  await mkdir(join(root, 'smart-folders'), { recursive: true })
  await writeFile(join(root, 'smart-folders/todos.yaml'),
    'id: todos\nname: 未完了TODO\nquery: LIST WHERE file.open_tasks\norder: 2\n')
  await writeFile(join(root, 'smart-folders/recent.yaml'),
    'id: recent\nname: 最近\nquery: LIST SORT file.mtime DESC LIMIT 5\norder: 1\n')
  await writeFile(join(root, 'a.md'), '# a\n\n- [ ] やること\n')
  await writeFile(join(root, 'b.md'), '# b\n')
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: smart-folders', () => {
  it('vault の YAML を order 順に返す', async () => {
    const body = (await (await call('/api/smart-folders')).json()) as { folders: SmartFolder[] }
    expect(body.folders.map((f) => f.id)).toEqual(['recent', 'todos'])
  })

  it('クエリを走らせて当てはまるノートを返す', async () => {
    const body = (await (await call('/api/smart-folders/todos/run')).json()) as SmartFolderResult
    expect(body.folder.name).toBe('未完了TODO')
    expect(body.result?.rows.map((r) => r.path)).toEqual(['a.md'])
  })

  it('無いものは 404', async () => {
    expect((await call('/api/smart-folders/none/run')).status).toBe(404)
  })

  it('作ると vault に YAML ができる (アプリの設定ファイルに逃がさない)', async () => {
    const created = (await (await post({ name: '本棚', query: 'LIST FROM #book' })).json()) as SmartFolder
    expect(created.id).toBe('本棚')
    // `#` で始まる値は YAML のコメントに読まれないよう引用される
    expect(await readFile(join(root, 'smart-folders/本棚.yaml'), 'utf8'))
      .toBe('id: 本棚\nname: 本棚\nquery: "LIST FROM #book"\n')
  })

  it('壊れたクエリは保存しない (あとで「なぜか 0 件」にしない)', async () => {
    const response = await post({ name: 'だめ', query: 'SELECT * FROM notes' })
    expect(response.status).toBe(400)
    expect((await (await call('/api/smart-folders')).json() as { folders: SmartFolder[] }).folders)
      .toHaveLength(2)
  })

  it('名前とクエリは必須 / 消せる (ノートは消えない)', async () => {
    expect((await post({ name: '' })).status).toBe(400)
    expect((await call('/api/smart-folders/todos', { method: 'DELETE' })).status).toBe(200)
    const body = (await (await call('/api/smart-folders')).json()) as { folders: SmartFolder[] }
    expect(body.folders.map((f) => f.id)).toEqual(['recent'])
    expect((await call('/api/notes/a.md')).status).toBe(200)
  })
})

describe('エージェントツール', () => {
  it('save は write が要り、壊れたクエリは断る', async () => {
    await expect(ctx.tools.invoke('save_smart_folder', { name: 'x', query: 'LIST' }, ['read']))
      .rejects.toThrow(/ケーパビリティが不足/)
    await expect(ctx.tools.invoke('save_smart_folder', { name: 'x', query: 'nope' }, ['write']))
      .rejects.toThrow(/LIST \/ TABLE \/ TASK/)
  })

  it('run_smart_folder は結果を返す', async () => {
    const body = await ctx.tools.invoke('run_smart_folder', { id: 'todos' }, ['read']) as SmartFolderResult
    expect(body.result?.rows).toHaveLength(1)
  })
})
