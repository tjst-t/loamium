/** search 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface SearchFilters {
  /** このタグが付いたノートだけ。親タグは子タグにも一致する */
  tag?: string
  /** このフォルダ配下だけ */
  folder?: string
}

export const searchApi = {
  search: (query: string, filters: SearchFilters = {}): string => {
    const params = new URLSearchParams({ q: query })
    if (filters.tag !== undefined && filters.tag !== '') params.set('tag', filters.tag)
    if (filters.folder !== undefined && filters.folder !== '') params.set('folder', filters.folder)
    return `/api/search?${params.toString()}`
  },
}
