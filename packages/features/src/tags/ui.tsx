import { defineUiFeature } from '@loamium/ui/src/feature'
import { tag } from './tag'

/**
 * タグ `#tag` (task #9)。
 *
 * 表示・クリックでの絞り込み・`#` の補完。タグ一覧そのものは検索機能 (search/ui.tsx) が出す。
 */
export default defineUiFeature({
  name: 'tags',
  requires: 'tags',
  // ⚠️ 補完は Enter / Tab をリストのコマンドより先に拾う必要がある
  editor: { order: 'before-preset', plugins: tag },
})
