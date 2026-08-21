import type { Context } from 'cordis'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { VaultPathError } from '@loamium/shared'

export interface HttpConfig { port: number; hostname: string }

export function http(ctx: Context, config: HttpConfig): void {
  const log = ctx.logger('http')
  const app = new Hono()

  // サービスは ctx 経由で取る。位置引数 DI を再発明しない
  app.get('/api/health', (c) =>
    c.json({ ok: true, notes: ctx.noteIndex.size, sseClients: ctx.sse.clientCount }),
  )
  app.get('/api/notes', (c) => c.json({ paths: ctx.noteIndex.paths() }))
  app.get('/api/notes/:path{.+}', async (c) => {
    try {
      return c.text(await ctx.vault.read(c.req.param('path')))
    } catch (err: unknown) {
      // 存在の有無を漏らさないため、不正パスも 404 に寄せる
      if (err instanceof VaultPathError) return c.json({ error: 'invalid_path', message: err.message }, 400)
      return c.json({ error: 'not_found' }, 404)
    }
  })
  app.post('/api/notes/:path{.+}', async (c) => {
    const path = c.req.param('path')
    try {
      await ctx.vault.write(path, await c.req.text())
    } catch (err: unknown) {
      if (err instanceof VaultPathError) return c.json({ error: 'invalid_path', message: err.message }, 400)
      throw err
    }
    return c.json({ ok: true, path })
  })

  ctx.effect(() => {
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.hostname }, (info) => {
      log.info('listening on http://%s:%d', info.address, info.port)
    })
    return () => new Promise<void>((r) => server.close(() => { log.info('http disposed'); r() }))
  })
}
http.inject = ['vault', 'noteIndex', 'sse']
