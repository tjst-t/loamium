import type { Context } from 'cordis'

export interface SyncConfig { debounceMs: number }

/**
 * git sync。関数プラグインの例 + effect による teardown。
 * vault/change の 3 本目のリスナー。
 */
export function sync(ctx: Context, config: SyncConfig): void {
  const log = ctx.logger('sync')
  let timer: NodeJS.Timeout | undefined

  ctx.on('vault/change', (path) => {
    log.info('scheduling auto-commit for %s', path)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { log.info('auto-commit (stub)') }, config.debounceMs)
  })

  // 手書きの逆順 shutdown チェーンを書かない。自分の後始末は自分で登録する
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
    log.info('sync disposed')
  })
}
sync.inject = ['vault']
