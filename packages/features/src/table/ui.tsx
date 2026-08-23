import { defineUiFeature } from '@loamium/ui/src/feature'
import { table } from './table'

/**
 * 表の WYSIWYG 編集 (task #15)。
 * preset の後に置く (GFM の table 系ノートが居る前提で動く)。
 */
export default defineUiFeature({
  name: 'table',
  editor: { order: 'after-preset', plugins: table },
})
