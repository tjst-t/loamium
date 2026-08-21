import { Service, type Context } from 'cordis'

/** インメモリインデックス。使い捨て・ファイルが正。 */
export class NoteIndexService extends Service {
  /** vault が立ち上がってから生成される。TDZ コメントではなく inject で順序を宣言する */
  static readonly inject = ['vault']
  private paths_ = new Set<string>()
  /** 初回構築の完了。API を受け付ける前にこれを待つこと */
  readonly ready: Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'noteIndex')

    ctx.on('vault/change', (path, op) => {
      if (op === 'upsert') this.paths_.add(path)
      else this.paths_.delete(path)
      ctx.logger('index').info('index updated: %s (%d notes)', path, this.paths_.size)
    })

    // 初回構築はプラグイン自身のライフサイクルに閉じ込める。
    // ⚠️ `await ctx.plugin(...)` は async effect の解決までは待たない (実測)。
    //    そのため準備完了は `ready` として明示的に公開し、呼び出し側はこれを待つ。
    this.ready = this.start().catch((err: unknown) => {
      ctx.logger('index').error('initial build failed: %s', String(err))
      throw err
    })
    ctx.effect(() => () => { this.paths_.clear() })
  }

  /** インデックスは使い捨て・ファイルが正。起動時に vault 全走査で構築する */
  async start(): Promise<void> {
    this.paths_.clear()
    for (const p of await this.ctx.vault.list()) this.paths_.add(p)
    this.ctx.logger('index').info('initial build: %d notes', this.paths_.size)
  }

  get size(): number { return this.paths_.size }
  paths(): string[] { return [...this.paths_] }
}
