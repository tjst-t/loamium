import { createApp } from './app'

const ctx = await createApp({
  vaultRoot: process.env['LOAMIUM_VAULT'] ?? './dev-vault',
  port: Number(process.env['PORT'] ?? 3000),
  hostname: process.env['LOAMIUM_HOST'] ?? '127.0.0.1',
})

const shutdown = (): void => {
  // 逆順チェーンを手書きしない。fiber.dispose() が effect を全部畳む
  void ctx.fiber.dispose().then(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
