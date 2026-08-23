/** files 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface VaultFile {
  path: string
  size: number
  /** ISO 8601 */
  mtime: string
}

/** 添付の置き場。ここに入れておけばノートの索引 (.md) とは混ざらない */
export const ASSETS_DIR = 'assets'

export const filesApi = {
  /** 添付の一覧 */
  list: (): string => '/api/files',
  /** 中身をそのまま配る (img / iframe の src にそのまま使える) */
  raw: (path: string): string => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`,
  /** アップロード (POST, 本文はバイト列そのまま) / 削除 (DELETE) */
  upload: (path: string): string => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`,
}
