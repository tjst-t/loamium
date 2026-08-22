import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { UiFeature } from './feature'
import journal from '@loamium/features/journal/ui'
import notes from '@loamium/features/notes/ui'
import search from '@loamium/features/search/ui'
import outline from '@loamium/features/outline/ui'
import toc from '@loamium/features/toc/ui'
import links from '@loamium/features/links/ui'
import tags from '@loamium/features/tags/ui'

/**
 * UI 機能の登録簿。**ここが唯一の登録場所。**
 *
 * サーバーの `app.ts` と対になる。機能を捨てるならフォルダごと消して、この行と
 * `app.ts` の行を消すだけ。動的 import はしない (CLAUDE.md: 静的登録)。
 *
 * **並び順がそのままサイドバーの並び順**になる (ジャーナル → ツリー → 詳細検索)。
 */
export const uiFeatures: UiFeature[] = [journal, notes, search, outline, toc, links, tags]

/**
 * サーバー側に無い機能は UI からも消す (リロードで反映される)。
 * `app.ts` から `ctx.plugin(tagsFeature)` を消せば、UI のタグ機能も一緒に消える。
 */
export function enabledFeatures(serverFeatures: readonly string[] | null): UiFeature[] {
  if (serverFeatures === null) return uiFeatures // 取得前は止めない (表示を待たせない)
  return uiFeatures.filter((f) => f.requires === undefined || serverFeatures.includes(f.requires))
}

/**
 * Milkdown プラグインを順序どおりに並べる。
 *
 * ⚠️ **順序が意味を持つ。** `[[` / `#` の補完は Enter / Tab をリストのコマンドより先に
 * 拾う必要があるので preset より前に置く。以前はこれを Editor.tsx と
 * milkdown-transform.ts の 2 箇所で手で揃えていて、片方への足し忘れで
 * 「テストと本番の構成がずれる」事故が起きうる状態だった。ここが唯一の出所。
 */
export function editorPlugins(features: readonly UiFeature[], order: 'before-preset' | 'after-preset'): MilkdownPlugin[] {
  return features.flatMap((f) => (f.editor?.order === order ? f.editor.plugins : []))
}
