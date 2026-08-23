import { useCallback, useEffect, useState, type JSX } from 'react'
import { Star } from 'lucide-react'
import { apiJson } from '@loamium/ui/src/api'
import { defineUiFeature, useShell } from '@loamium/ui/src/feature'
import { applyPropertyEdit, readProperties } from '@loamium/shared'
import { bookmarksApi, BOOKMARK_KEY, type Bookmark } from './contract'

/**
 * ブックマーク (task #18 / ADR-0004)。
 *
 * ★ はノートの frontmatter `bookmark: true` を付け外しするだけ。
 * 書き込みは properties と同じで **1 キーずつ**、画面はローカルで先に合わせる
 * (読み直すとエディタが作り直されてカーソルが飛ぶ)。
 */

/** 一覧を持つ小さなストア。★ を押した機能自身が更新を撒く (機能どうしは繋がない) */
let bookmarks: Bookmark[] = []
const listeners = new Set<() => void>()

function publish(next: Bookmark[]): void {
  bookmarks = next
  for (const listener of listeners) listener()
}

async function refresh(): Promise<void> {
  try {
    publish((await apiJson<{ bookmarks: Bookmark[] }>(bookmarksApi.list())).bookmarks)
  } catch {
    // 取れないだけ。編集は続けられる
  }
}

function useBookmarks(): Bookmark[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = (): void => { setTick((v) => v + 1) }
    listeners.add(listener)
    void refresh()
    return () => { listeners.delete(listener) }
  }, [])
  return bookmarks
}

function StarButton({ path }: { path: string }): JSX.Element | null {
  const { content, patchContent } = useShell()
  const on = content !== null && readProperties(content).find((p) => p.key === BOOKMARK_KEY)?.value === true

  const toggle = useCallback(() => {
    if (content === null) return
    const next = !on
    patchContent(applyPropertyEdit(content, next
      ? { key: BOOKMARK_KEY, value: { type: 'boolean', value: true } }
      : { key: BOOKMARK_KEY, remove: true }))
    apiJson(bookmarksApi.toggle(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, bookmark: next }),
    }).then(refresh, () => { /* 失敗しても画面は戻さない (次に開けば実体が出る) */ })
  }, [content, on, patchContent, path])

  if (content === null) return null
  return (
    <button
      type="button"
      className={`star-button${on ? ' is-on' : ''}`}
      aria-pressed={on}
      title={on ? 'ブックマークを外す' : 'ブックマークに入れる'}
      aria-label={on ? 'ブックマークを外す' : 'ブックマークに入れる'}
      onClick={toggle}
    >
      <Star size={16} fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}

function BookmarkList(): JSX.Element | null {
  const { openNote, currentPath } = useShell()
  const list = useBookmarks()
  if (list.length === 0) return null
  return (
    <section>
      <h2 className="section-label"><Star size={12} /> ブックマーク</h2>
      <ul className="bookmark-list">
        {list.map((bookmark) => (
          <li key={bookmark.path}>
            <button
              type="button"
              className="bookmark"
              aria-current={bookmark.path === currentPath}
              onClick={() => { openNote(bookmark.path) }}
            >
              {bookmark.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default defineUiFeature({
  name: 'bookmarks',
  requires: 'bookmarks',
  noteAction: ({ path }) => <StarButton path={path} />,
  sidebarItem: () => <BookmarkList />,
})
