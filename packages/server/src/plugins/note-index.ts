import { Service, type Context } from 'cordis'

/** インメモリインデックス。使い捨て・ファイルが正。 */
export class NoteIndexService extends Service {
  /** vault が立ち上がってから生成される。TDZ コメントではなく inject で順序を宣言する */
  static readonly inject = ['vault']
  private paths_ = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'noteIndex')

    ctx.on('vault/change', (path, op) => {
      if (op === 'upsert') this.paths_.add(path)
      else this.paths_.delete(path)
      ctx.logger('index').info('index updated: %s (%d notes)', path, this.paths_.size)
    })
  }

  async start(): Promise<void> {
    for (const p of await this.ctx.vault.list()) this.paths_.add(p)
    this.ctx.logger('index').info('initial build: %d notes', this.paths_.size)
  }

  get size(): number { return this.paths_.size }
  paths(): string[] { return [...this.paths_] }
}
