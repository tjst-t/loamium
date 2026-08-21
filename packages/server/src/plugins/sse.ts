import { Service, type Context } from 'cordis'

export class SseService extends Service {
  static readonly inject = []
  private clients_ = new Set<(chunk: string) => void>()

  constructor(ctx: Context) {
    super(ctx, 'sse')

    // vault/change の 2 本目のリスナー。index とは完全に独立している
    ctx.on('vault/change', (path, op) => {
      this.broadcast({ type: 'notes_changed', path, op })
    })

    // cordis 4 の teardown は ctx.on('dispose') ではなく effect
    ctx.effect(() => {
      ctx.logger('sse').info('sse ready')
      return () => {
        this.clients_.clear()
        ctx.logger('sse').info('sse disposed')
      }
    })
  }

  subscribe(fn: (chunk: string) => void): () => void {
    this.clients_.add(fn)
    return () => this.clients_.delete(fn)
  }

  broadcast(payload: unknown): void {
    const chunk = `data: ${JSON.stringify(payload)}\n\n`
    for (const c of this.clients_) c(chunk)
  }

  get clientCount(): number { return this.clients_.size }
}
