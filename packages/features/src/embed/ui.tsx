import { defineUiFeature } from '@loamium/ui/src/feature'
import { embed } from './embed'

/**
 * 埋め込み `![[ノート#見出し]]` (task #13)。
 * 本文の文字列はそのままに、中身のカードを添えて見せる。
 */
export default defineUiFeature({
  name: 'embed',
  requires: 'embed',
  editor: { order: 'after-preset', plugins: embed },
})
