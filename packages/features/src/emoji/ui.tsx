import { defineUiFeature } from '@loamium/ui/src/feature'
import { emoji } from './emoji'

/**
 * 絵文字の補完 (task #52)。半角 `:` で候補を出し、**絵文字そのもの**を入れる。
 *
 * ⚠️ 補完は Enter / Tab をリストのコマンドより先に拾う必要があるので `before-preset`。
 */
export default defineUiFeature({
  name: 'emoji',
  editor: { order: 'before-preset', plugins: emoji },
})
