import 'katex/dist/katex.min.css'
import { defineUiFeature } from '@loamium/ui/src/feature'
import { math } from './math'

/**
 * 数式 `$…$` / `$$…$$` (task #14)。
 * KaTeX の CSS はここで読む (この機能を外せばフォントも読まれない)。
 */
export default defineUiFeature({
  name: 'math',
  editor: { order: 'after-preset', plugins: math },
})
