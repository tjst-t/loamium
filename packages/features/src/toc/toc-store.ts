import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * 目次パネルとエディタの橋渡し。
 *
 * パネルは React、折りたたみは ProseMirror プラグインなので、**いま開いているビュー**を
 * ここで受け渡す。エディタが差し替わるたびに register し直す。
 */
let current: EditorView | null = null
const listeners = new Set<() => void>()

export function registerEditorView(view: EditorView | null): void {
  current = view
  notify()
}

export function activeEditorView(): EditorView | null {
  return current
}

/** ドキュメントや折りたたみが変わったことを知らせる */
export function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
