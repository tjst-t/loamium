import './types'
import { Context } from 'cordis'
import { logging } from './plugins/logging'
import { VaultService } from './plugins/vault'
import { NoteIndexService } from './plugins/note-index'
import { SseService } from './plugins/sse'
import { sync } from './plugins/sync'
import { http } from './plugins/http'

/**
 * 本番エントリ。プラグインは **静的に import して静的に登録** する。
 * `@cordisjs/loader` / HMR は dev 専用 (dev.ts)。
 * 設定駆動の動的 import() は `bun --compile` で静的解決できず必ず壊れるため。
 */
const ctx = new Context()

ctx.plugin(logging, { level: 3 })
ctx.plugin(VaultService, { root: process.env.LOAMIUM_VAULT ?? './dev-vault' })
ctx.plugin(NoteIndexService)
ctx.plugin(SseService)
ctx.plugin(sync, { debounceMs: 500 })
ctx.plugin(http, {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.LOAMIUM_HOST ?? '127.0.0.1',
})

await ctx.inject(['noteIndex'], async (c) => {
  await c.noteIndex.start()
})

const shutdown = (): void => {
  // 逆順チェーンを手書きしない。fiber.dispose() が effect を全部畳む
  void ctx.fiber.dispose().then(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
