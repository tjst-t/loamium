/**
 * ノートごとの表示状態 (スクロール位置とカーソル位置) を憶えておく (task #2)。
 *
 * 保持はメモリだけ。**ファイルにも localStorage にも書かない** —
 * 正本は Markdown であって「どこを見ていたか」は文書の一部ではない (不変条件 1)。
 * リロードで消えて構わないが、ノート A → B → 戻る の 1 セッション内では必ず復元する。
 */
export interface NoteViewState {
  /** ProseMirror のドキュメント内位置 */
  cursor: number
  scrollTop: number
}

const states = new Map<string, NoteViewState>()

export function saveNoteViewState(path: string, state: NoteViewState): void {
  states.set(path, state)
}

export function getNoteViewState(path: string): NoteViewState | undefined {
  return states.get(path)
}

/** リネーム・移動に追従する (パスが変わっても同じノート) */
export function renameNoteViewState(from: string, to: string): void {
  const state = states.get(from)
  if (state === undefined) return
  states.delete(from)
  states.set(to, state)
}

export function forgetNoteViewState(path: string): void {
  states.delete(path)
}

/** テスト用 */
export function clearNoteViewStates(): void {
  states.clear()
}
