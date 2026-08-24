import type { QueryResult } from '@loamium/shared'

/** dataview 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export type { QueryResult }

export interface QueryResponse {
  result?: QueryResult
  /** 書き方が違うときは理由を返す (黙って空にしない) */
  error?: string
}

/** この言語名のコードフェンスがクエリ (Obsidian dataview と同じ) */
export const QUERY_LANG = 'dataview'

export const dataviewApi = {
  run: (): string => '/api/query',
}
