import { defineUiFeature } from '@loamium/ui/src/feature'
import { outline } from './outline'

/**
 * アウトライン操作 (task #10)。
 * Tab / Shift+Tab のインデント・折りたたみ・リスト種別の変換。
 *
 * サーバー側の機能を持たない (エディタの中で完結する) ので `requires` は無い。
 * 順序は preset の**後**: リストのコマンド (sinkListItem 等) が居る前提で足すため。
 */
export default defineUiFeature({
  name: 'outline',
  editor: { order: 'after-preset', plugins: outline },
})
