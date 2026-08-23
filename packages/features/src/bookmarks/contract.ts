/** bookmarks 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface Bookmark {
  path: string
  /** frontmatter の `title:`。無ければファイル名 */
  title: string
}

/**
 * ブックマークは frontmatter の `bookmark: true` (ADR-0004)。
 * 設定ファイルの一覧ではなく**ノート自身**に載るので、ファイルと一緒に旅をする。
 */
export const BOOKMARK_KEY = 'bookmark'

export const bookmarksApi = {
  list: (): string => '/api/bookmarks',
  /** 付け外し (PUT) */
  toggle: (): string => '/api/bookmarks',
}
