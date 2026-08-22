/** links 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface Backlink {
  path: string
  /** 1 始まりの行番号 */
  line: number
  snippet: string
  /** リンクの書き方 (`[[…]]` 全体) */
  raw: string
}

export interface OutgoingLink {
  target: string
  heading: string | null
  alias: string | null
  /** 解決できた vault パス。null なら壊れリンク */
  path: string | null
  line: number
}

export const linksApi = {
  backlinks: (path: string): string => `/api/backlinks?path=${encodeURIComponent(path)}`,
  links: (path: string): string => `/api/links?path=${encodeURIComponent(path)}`,
  broken: (): string => '/api/broken-links',
}
