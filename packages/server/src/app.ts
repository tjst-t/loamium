import './types'
import { Context } from 'cordis'
import { logging } from './plugins/logging'
import { VaultService } from './plugins/vault'
import { NoteIndexService } from './plugins/note-index'
import { SseService } from './plugins/sse'
import { HttpService } from './plugins/http'
import { ToolsService } from './plugins/tools'
import { sync } from './plugins/sync'
import { notesFeature } from './features/notes'
import { fmtFeature } from './features/fmt'
import { agentFeature } from './features/agent'

export interface AppConfig {
  vaultRoot: string
  port: number
  hostname: string
  logLevel?: number
}

/**
 * アプリの合成。**プラグインは静的に import して静的に登録する。**
 * `@cordisjs/loader` / HMR は dev 専用。設定駆動の動的 import() は
 * `bun --compile` で静的解決できず必ず壊れるため。
 *
 * 生成順序はコメントではなく各プラグインの `inject` が解決する。
 */
export async function createApp(config: AppConfig): Promise<Context> {
  const ctx = new Context()

  ctx.plugin(logging, { level: config.logLevel ?? 3 })
  ctx.plugin(VaultService, { root: config.vaultRoot })
  ctx.plugin(NoteIndexService)
  ctx.plugin(SseService)
  ctx.plugin(ToolsService)
  ctx.plugin(HttpService, { port: config.port, hostname: config.hostname })
  ctx.plugin(sync, { debounceMs: 500 })

  // 1 機能 = 1 プラグイン。REST・エージェントツール・help を同時に登録する
  ctx.plugin(notesFeature)
  ctx.plugin(fmtFeature)
  ctx.plugin(agentFeature)

  // インデックスは使い捨て・ファイルが正。全走査が終わってから受け付ける。
  // inject でサービスの生成を待ち、そのうえで初回構築の完了 (ready) を待つ。
  // `await ctx.plugin(...)` は async effect の解決までは待たないので、これが必要。
  await new Promise<void>((resolve, reject) => {
    ctx.inject(['noteIndex'], (c) => { c.noteIndex.ready.then(resolve, reject) })
  })
  return ctx
}
