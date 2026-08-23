import { defineUiFeature } from '@loamium/ui/src/feature'
import { diagram } from './diagram'

/**
 * Mermaid 図 (task #14)。
 * ` ```mermaid ` のフェンスを図として描く。Mermaid 本体は図があるときだけ読み込む。
 */
export default defineUiFeature({
  name: 'diagram',
  editor: { order: 'after-preset', plugins: diagram },
})
