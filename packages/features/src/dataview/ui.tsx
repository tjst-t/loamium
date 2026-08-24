import { defineUiFeature } from '@loamium/ui/src/feature'
import { queryBlock } from './query-block'

/**
 * クエリブロック (task #20)。
 * preset の後に置く (code_block の型と language 属性が居る前提)。
 */
export default defineUiFeature({
  name: 'dataview',
  requires: 'dataview',
  editor: { order: 'after-preset', plugins: queryBlock },
})
