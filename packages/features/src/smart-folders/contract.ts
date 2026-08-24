import type { QueryResult } from '@loamium/shared'

/** smart-folders 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface SmartFolder {
  /** ファイル名になる (`smart-folders/<id>.yaml`) */
  id: string
  name: string
  /** lucide のアイコン名 (無ければ既定) */
  icon?: string
  /** dataview と同じクエリ */
  query: string
  /** 並び順 (小さいほど上) */
  order?: number
}

/** 置き場所。**vault の中の普通の YAML** なので、ノートと一緒に旅をする (ADR-0010) */
export const SMART_FOLDER_DIR = 'smart-folders'

export interface SmartFolderResult {
  folder: SmartFolder
  result?: QueryResult
  /** 書き方が違うときは理由 (黙って空にしない) */
  error?: string
}

export const smartFoldersApi = {
  list: (): string => '/api/smart-folders',
  run: (id: string): string => `/api/smart-folders/${encodeURIComponent(id)}/run`,
  save: (): string => '/api/smart-folders',
  remove: (id: string): string => `/api/smart-folders/${encodeURIComponent(id)}`,
}
