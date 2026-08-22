import { defineUiFeature } from '@loamium/ui/src/feature'
import { format } from './format'

/**
 * 選択したテキストの変換 (task #50)。
 * 太字・斜体・コード・取り消し線・ノートへのリンク。
 *
 * サーバー側の機能を持たない。preset の**後**に置く (マークの型が居る前提で動く)。
 */
export default defineUiFeature({
  name: 'format',
  editor: { order: 'after-preset', plugins: format },
})
