/**
 * エディタ (ProseMirror プラグイン) と React の橋渡し (task #4 / #9)。
 *
 * プラグインはノート一覧・タグ一覧やナビゲーションの手段を知らないので、React 側から差し込む。
 * ノートを開き直すたびに Editor が入れ替える。
 */
export interface EditorEnv {
  /** vault の全ノート (リンク解決と `[[` 補完に使う) */
  notes: readonly string[]
  /** vault で使われているタグ (`#` 補完に使う) */
  tags: readonly string[]
  /** 編集中のノート。同名ノートの解決でリンク元のフォルダを優先するために要る */
  currentPath: string
  /** 解決できたリンクを開く */
  open: (path: string) => void
  /** 壊れリンクをクリックしたとき (新規作成の導線) */
  create: (target: string) => void
  /** タグをクリックしたとき (詳細検索へ) */
  openTag: (tag: string) => void
}

const EMPTY: EditorEnv = {
  notes: [], tags: [], currentPath: '', open: () => {}, create: () => {}, openTag: () => {},
}

let env: EditorEnv = EMPTY

export function setEditorEnv(next: EditorEnv): void {
  env = next
}

export function getEditorEnv(): EditorEnv {
  return env
}

/** テスト用 */
export function resetEditorEnv(): void {
  env = EMPTY
}
