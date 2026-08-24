import './types'
import { Context } from 'cordis'
import { logging } from './plugins/logging'
import { VaultService } from './plugins/vault'
import { NoteIndexService } from './plugins/note-index'
import { SseService } from './plugins/sse'
import { HttpService } from './plugins/http'
import { ToolsService } from './plugins/tools'
import { sync } from './plugins/sync'
import { notesFeature } from '@loamium/features/notes/server'
import { fmtFeature } from '@loamium/features/fmt/server'
import { journalFeature } from '@loamium/features/journal/server'
import { searchFeature } from '@loamium/features/search/server'
import { linksFeature } from '@loamium/features/links/server'
import { tagsFeature } from '@loamium/features/tags/server'
import { embedFeature } from '@loamium/features/embed/server'
import { propertiesFeature } from '@loamium/features/properties/server'
import { filesFeature } from '@loamium/features/files/server'
import { bookmarksFeature } from '@loamium/features/bookmarks/server'
import { tasksFeature } from '@loamium/features/tasks/server'
import { dataviewFeature } from '@loamium/features/dataview/server'
import { agentFeature } from '@loamium/features/agent/server'

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
  ctx.plugin(journalFeature)
  ctx.plugin(searchFeature)
  ctx.plugin(linksFeature)
  ctx.plugin(tagsFeature)
  ctx.plugin(embedFeature)
  ctx.plugin(propertiesFeature)
  ctx.plugin(filesFeature)
  ctx.plugin(bookmarksFeature)
  ctx.plugin(tasksFeature)
  ctx.plugin(dataviewFeature)
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
