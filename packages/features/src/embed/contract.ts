/** embed 機能の REST 契約。**両側が import する**ので React も Node も含めない */
export interface EmbedResult {
  /** 埋め込み先の vault パス。解決できなければ null */
  path: string | null
  /** `#見出し` を指していたらその節、無ければノート全体 */
  heading: string | null
  /** 表示する本文 (長いときは切り詰める) */
  excerpt: string
  /** 切り詰めたか */
  truncated: boolean
}

export const embedApi = {
  /** `![[…]]` の中身をそのまま渡す (`ノート#見出し`) */
  resolve: (target: string, from: string): string =>
    `/api/embed?target=${encodeURIComponent(target)}&from=${encodeURIComponent(from)}`,
}
