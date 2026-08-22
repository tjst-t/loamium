import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { foldTag, parseInlineTags } from '@loamium/shared'
import { createSuggest } from '@loamium/ui/src/editor/suggest'
import { getEditorEnv } from '@loamium/ui/src/editor/editor-env'

/**
 * タグ `#tag` (task #9)。
 *
 * WikiLink と同じく**スキーマにノードを足さない**。`#tag` はテキストのまま置き、
 * 見た目とクリックだけを decoration で足す (serializer を触らないので round-trip に影響しない)。
 */
const tagDecorations = new Plugin({
  key: new PluginKey('loamium-tag'),
  props: {
    decorations(state) {
      const decorations: Decoration[] = []
      state.doc.descendants((node, pos, parent) => {
        if (!node.isText || node.text === null || node.text === undefined) return true
        if (parent?.type.spec.code === true) return false
        if (node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === 'inlineCode')) return true
        for (const ref of parseInlineTags(node.text)) {
          decorations.push(Decoration.inline(pos + ref.start, pos + ref.end, {
            class: 'tag-chip',
            'data-tag': ref.tag,
            title: `#${ref.tag} で絞り込む`,
          }))
        }
        return true
      })
      return DecorationSet.create(state.doc, decorations)
    },

    /** クリックで詳細検索へ */
    handleClick(_view, _pos, event) {
      const el = event.target instanceof HTMLElement ? event.target.closest('.tag-chip') : null
      if (!(el instanceof HTMLElement)) return false
      const tag = el.dataset['tag'] ?? ''
      if (tag === '') return false
      getEditorEnv().openTag(tag)
      return true
    },
  },
})

/** 候補。前方一致 → 部分一致 */
export function suggestTags(query: string, tags: readonly string[]): string[] {
  const needle = foldTag(query.trim())
  return tags
    .map((tag) => ({ tag, rank: needle === '' ? 1 : foldTag(tag).startsWith(needle) ? 0 : foldTag(tag).includes(needle) ? 1 : -1 }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.tag.localeCompare(b.tag, 'ja'))
    .slice(0, 8)
    .map((entry) => entry.tag)
}

/**
 * カーソルの直前が書きかけの `#…` なら、その範囲を返す。
 * 見出し (`# `) は空白が入るのでここには来ない。
 */
function activeTagQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  if ($from.parent.type.spec.code === true) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const match = /(?<![\p{L}\p{N}_/-])#([^\s#[\]{}()（）「」『』、。,.!?！？"'`|]*)$/u.exec(before)
  if (match === null) return null
  // 見出し記法の途中 (`##`) では出さない
  if (/^#+$/.test(before.trim()) && $from.parentOffset === before.length && before.trim().length > 1) return null
  const query = match[1] ?? ''
  return { from: $from.pos - query.length, to: $from.pos, query }
}

export const tagSuggest = createSuggest({
  name: 'loamium-tag-suggest',
  header: (query) => (query === '' ? 'タグ' : `タグ: ${query}`),
  match: activeTagQuery,
  items: (query) => suggestTags(query, getEditorEnv().tags).map((tag) => ({
    title: `#${tag}`,
    value: tag,
  })),
  apply: (view, item, range) => {
    const tr = view.state.tr.insertText(item.value, range.from, range.to)
    tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + item.value.length)))
    view.dispatch(tr.scrollIntoView())
  },
})

/** 表示・クリックと補完。**preset より前に use すること** */
export const tag = [$prose(() => tagDecorations), $prose(() => tagSuggest)]

/** テスト用 */
export function tagSuggestStateOf(state: EditorState): ReturnType<typeof tagSuggest.activeState> {
  return tagSuggest.activeState(state)
}
