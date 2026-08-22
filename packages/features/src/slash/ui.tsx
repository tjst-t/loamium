import { defineUiFeature } from '@loamium/ui/src/feature'
import { slash } from './slash'

/**
 * スラッシュメニュー (task #12)。`/` で挿入候補を出す。
 *
 * サーバー側の機能を持たない (エディタの中で完結する)。
 * ⚠️ 補完は Enter / Tab をリストのコマンドより先に拾う必要があるので `before-preset`。
 */
export default defineUiFeature({
  name: 'slash',
  editor: { order: 'before-preset', plugins: slash },
})
