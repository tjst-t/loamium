import { defineUiFeature } from '@loamium/ui/src/feature'
import { attachments } from './attach'

/**
 * 添付ファイル (task #16)。
 * ドラッグ&ドロップ / 貼り付けで `assets/` に上げ、`![[…]]` を差し込んでプレビューする。
 * preset の後に置く (テキストの上に decoration を重ねるだけ)。
 */
export default defineUiFeature({
  name: 'files',
  requires: 'files',
  editor: { order: 'after-preset', plugins: attachments },
})
