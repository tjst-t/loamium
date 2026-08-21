import { Logger, type Context, type Exporter, type Message } from 'cordis'

/**
 * cordis 4 の LoggerService は既定で exporter を持たず、何も出力しない。
 * 標準出力への exporter を明示登録する。
 */
export function logging(ctx: Context, config: { level?: number } = {}): void {
  const exporter: Exporter = {
    colors: process.stdout.isTTY ? 8 : false,
    levels: { default: config.level ?? 2 },
    export(message: Message) {
      const line = Logger.format(exporter, message)
      if (message.type === 'error') process.stderr.write(line + '\n')
      else process.stdout.write(line + '\n')
    },
  }
  ctx.effect(() => ctx.logger.exporter(exporter))
}
