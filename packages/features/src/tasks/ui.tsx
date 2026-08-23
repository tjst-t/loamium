import { defineUiFeature } from '@loamium/ui/src/feature'
import { taskFields } from './task-fields'

/**
 * タスク (task #19 / ADR-0029)。
 * チェックボックスは preset (GFM) のもの。ここが足すのは
 * `[status:: …]` のようなインラインフィールドのピルと、完了との同期だけ。
 */
export default defineUiFeature({
  name: 'tasks',
  requires: 'tasks',
  editor: { order: 'after-preset', plugins: taskFields },
})
