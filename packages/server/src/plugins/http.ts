import { Service, type Context } from 'cordis'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { VaultPathError } from '@loamium/shared'
import { VaultConflictError, VaultNotFoundError } from '../errors'

export interface HttpConfig { port: number; hostname: string }

/**
 * HTTP の口。ルートは各 feature が `mount` で持ち込む (1 機能 = 1 プラグイン)。
 * ここに機能別のルートを直接書かないこと。
 */
export class HttpService extends Service {
  static readonly inject = []
  private app = new Hono()

  constructor(ctx: Context, public config: HttpConfig) {
    super(ctx, 'http')

    this.app.onError((err, c) => {
      if (err instanceof VaultPathError) {
        return c.json({ error: 'invalid_path', message: err.message }, 400)
      }
      if (err instanceof VaultNotFoundError) {
        return c.json({ error: 'not_found', message: err.message }, 404)
      }
      if (err instanceof VaultConflictError) {
        return c.json({ error: 'conflict', message: err.message }, 409)
      }
      ctx.logger('http').error('unhandled: %s', err instanceof Error ? err.stack ?? err.message : String(err))
      return c.json({ error: 'internal_error' }, 500)
    })

    ctx.effect(() => {
      const server = serve(
        { fetch: this.app.fetch, port: config.port, hostname: config.hostname },
        (info) => { ctx.logger('http').info('listening on http://%s:%d', info.address, info.port) },
      )
      return () => new Promise<void>((r) => server.close(() => {
        ctx.logger('http').info('http disposed')
        r()
      }))
    })
  }

  /** Hono はサーバ起動後でもルートを足せるので、feature の登録順を気にしなくてよい */
  mount(register: (app: Hono) => void): void {
    register(this.app)
  }

  /** テスト用: サーバを立てずにリクエストを流す */
  get fetch(): Hono['fetch'] {
    return this.app.fetch
  }
}
