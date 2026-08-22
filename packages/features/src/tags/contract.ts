/** tags 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface TagCount {
  tag: string
  count: number
}

export const tagsApi = {
  list: (): string => '/api/tags',
  notes: (tag: string): string => `/api/tags/notes?tag=${encodeURIComponent(tag)}`,
}
