/** @vitest-environment node */
/**
 * クエリ (task #20 / ADR-0001)。
 * **索引を持たず毎回走査する**ので、外部から書かれた直後でも結果が最新になる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '@loamium/server/src/app'
import type { QueryResponse } from '../contract'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>

const query = async (source: string): Promise<QueryResponse> =>
  (await (await call('/api/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: source }),
  })).json()) as QueryResponse

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-dql-'))
  await mkdir(join(root, 'データ'), { recursive: true })
  await writeFile(join(root, 'データ/本.md'), '---\ntitle: 失敗の科学\nstatus: 読了\nrating: 5\n---\n\n#book\n\n- [ ] 感想を書く\n')
  await writeFile(join(root, 'データ/SF.md'), '---\nstatus: 読書中\nrating: 3\n---\n\n#book\n')
  await writeFile(join(root, 'index.md'), '# index\n')
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: query', () => {
  it('LIST をタグで絞る', async () => {
    const body = await query('LIST FROM #book SORT file.name ASC')
    expect(body.result?.rows.map((r) => r.path)).toEqual(['データ/SF.md', 'データ/本.md'])
  })

  it('TABLE は列の順に値を返す', async () => {
    const body = await query('TABLE status, rating FROM #book SORT rating DESC')
    expect(body.result?.columns).toEqual(['status', 'rating'])
    expect(body.result?.rows[0]?.values).toEqual(['読了', 5])
  })

  it('TASK は行番号つきで返す (押したら元の行を書き換えられる)', async () => {
    const body = await query('TASK FROM "データ"')
    expect(body.result?.rows[0]?.task).toMatchObject({ line: 8, checked: false, text: "感想を書く" })
  })

  it('書き方が違えば理由を返す (黙って空にしない)', async () => {
    expect((await query('SELECT * FROM notes')).error).toMatch(/LIST \/ TABLE \/ TASK/)
    expect((await call('/api/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(400)
  })

  it('ファイルが変われば次のクエリに出る (索引を持たない)', async () => {
    expect((await query('LIST WHERE status = "読了"')).result?.rows).toHaveLength(1)
    await ctx.vault.write('データ/SF.md', '---\nstatus: 読了\n---\n')
    expect((await query('LIST WHERE status = "読了"')).result?.rows).toHaveLength(2)
  })
})

describe('エージェントツール', () => {
  it('run_query は read で使える', async () => {
    const body = await ctx.tools.invoke('run_query', { query: 'LIST FROM #book' }, ['read']) as QueryResponse
    expect(body.result?.rows).toHaveLength(2)
  })
})
