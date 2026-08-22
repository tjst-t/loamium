/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { logging } from '../plugins/logging'
import { VaultService } from '../plugins/vault'
import { NoteIndexService } from '../plugins/note-index'
import { SseService } from '../plugins/sse'
import { HttpService } from '../plugins/http'
import { ToolsService } from '../plugins/tools'
import { notesFeature } from '@loamium/features/notes/server'
import { searchFeature } from '@loamium/features/search/server'
import { tagsFeature } from '@loamium/features/tags/server'
import { linksFeature } from '@loamium/features/links/server'
import { agentFeature } from '@loamium/features/agent/server'

let root: string
let ctx: Context
const call = (path: string): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`)) as Promise<Response>

async function boot(extra: ((c: Context) => void)[]): Promise<void> {
  ctx = new Context()
  ctx.plugin(logging, { level: 0 })
  ctx.plugin(VaultService, { root })
  ctx.plugin(NoteIndexService)
  ctx.plugin(SseService)
  ctx.plugin(ToolsService)
  ctx.plugin(HttpService, { port: 0, hostname: '127.0.0.1' })
  for (const p of extra) ctx.plugin(p)
  await new Promise<void>((resolve, reject) => {
    ctx.inject(['noteIndex'], (c) => { c.noteIndex.ready.then(resolve, reject) })
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-plug-'))
  await writeFile(join(root, 'a.md'), '#タグ [[b]]\n')
  await writeFile(join(root, 'b.md'), '# b\n')
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * 「1 機能 = 1 プラグイン」が本当に成立しているかを固定する。
 *
 * 設計は口で言えても、実際に外して動くかは別問題なので実測で守る。
 * **つけ外しは合成時 (app.ts の登録行) の話**で、実行時のホット着脱は対象外
 * (Hono はルートを外せず、ToolsService も登録の取り消しを持たない)。
 */
describe('機能のつけ外し', () => {
  it('tags を外しても notes / search / links は動く', async () => {
    await boot([notesFeature, searchFeature, linksFeature])
    expect((await call('/api/tags')).status).toBe(404)
    expect((await call('/api/notes')).status).toBe(200)
    expect((await call('/api/backlinks?path=b.md')).status).toBe(200)
    // search の tag 絞り込みは tags プラグインではなく shared に依存している
    const r = await call(`/api/search?q=&tag=${encodeURIComponent('タグ')}`)
    expect(((await r.json()) as { hits: unknown[] }).hits).toHaveLength(1)
  })

  it('notes だけでも起動する', async () => {
    await boot([notesFeature])
    expect((await call('/api/notes')).status).toBe(200)
    expect((await call('/api/search?q=b')).status).toBe(404)
    expect((await call('/api/tags')).status).toBe(404)
  })

  it('機能を足すと REST・ツール・help が同時に増える (defineFeature の契約)', async () => {
    await boot([notesFeature])
    expect(ctx.tools.get('list_tags')).toBeUndefined()
    expect(ctx.tools.help('tags')).toBeUndefined()

    ctx.plugin(tagsFeature)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await call('/api/tags')).status).toBe(200)
    expect(ctx.tools.get('list_tags')).toBeDefined()
    expect(ctx.tools.help('tags')).toBeDefined()
  })

  it('⚠️ リンク追従だけは links 機能ではなく vault サービスに埋まっている', async () => {
    // UI・CLI・エージェントのどの経路の move でも追従させるための意図的な配置。
    // 裏を返すと **links 機能を外しても追従は消えない**。この非対称は自覚しておく
    await boot([notesFeature])
    await ctx.vault.move('b.md', 'c.md')
    expect(await ctx.vault.read('a.md')).toBe('#タグ [[c]]\n')
  })
})

describe('/api/features — UI 側の有効・無効の出所', () => {
  it('登録された機能の名前が返る', async () => {
    await boot([notesFeature, searchFeature, agentFeature])
    const body = (await (await call('/api/features')).json()) as { features: string[] }
    expect(body.features).toEqual(['agent', 'notes', 'search'])
  })

  it('外した機能は名前も返らない (UI はこれを見て自分を無効にする)', async () => {
    await boot([notesFeature, searchFeature, tagsFeature, agentFeature])
    const withTags = (await (await call('/api/features')).json()) as { features: string[] }
    expect(withTags.features).toContain('tags')

    await ctx.fiber.dispose()
    await boot([notesFeature, searchFeature, agentFeature])
    const without = (await (await call('/api/features')).json()) as { features: string[] }
    expect(without.features).not.toContain('tags')
  })
})
