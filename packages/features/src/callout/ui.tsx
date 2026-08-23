import { defineUiFeature } from '@loamium/ui/src/feature'
import { callout } from './callout'

/**
 * callout (`> [!note]`) とハイライト (`==…==`) の表示 (task #13)。
 *
 * どちらも Obsidian の既存慣行そのままで、**スキーマも serializer も触らない**。
 * preset の後に置く (blockquote / text の型が居る前提)。
 */
export default defineUiFeature({
  name: 'callout',
  editor: { order: 'after-preset', plugins: callout },
})
