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
  // ⚠️ **preset より前。** Backspace / Delete を base keymap の joinBackward より先に
  //    拾わないと、隣の行から寄せて画像を消す操作が効かない
  editor: { order: 'before-preset', plugins: attachments },
})
