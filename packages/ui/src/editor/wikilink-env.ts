/**
 * エディタ (ProseMirror プラグイン) と React の橋渡し (task #4)。
 *
 * プラグインはノート一覧やナビゲーションの手段を知らないので、
 * React 側から差し込む。ノートを開き直すたびに Editor が入れ替える。
 */
export interface WikiLinkEnv {
  /** vault の全ノート (リンク解決と補完候補に使う) */
  notes: readonly string[]
  /** 編集中のノート。同名ノートの解決でリンク元のフォルダを優先するために要る */
  currentPath: string
  /** 解決できたリンクを開く */
  open: (path: string) => void
  /** 壊れリンクをクリックしたとき (新規作成の導線) */
  create: (target: string) => void
}

const EMPTY: WikiLinkEnv = { notes: [], currentPath: '', open: () => {}, create: () => {} }

let env: WikiLinkEnv = EMPTY

export function setWikiLinkEnv(next: WikiLinkEnv): void {
  env = next
}

export function getWikiLinkEnv(): WikiLinkEnv {
  return env
}

/** テスト用 */
export function resetWikiLinkEnv(): void {
  env = EMPTY
}
