import { defineUiFeature } from '@loamium/ui/src/feature'
import { code } from './code'

/**
 * コードフェンスの色付け (task #14)。
 * preset の後に置く (code_block の型と language 属性が居る前提)。
 */
export default defineUiFeature({
  name: 'code',
  editor: { order: 'after-preset', plugins: code },
})
