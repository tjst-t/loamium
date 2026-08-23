/** tasks 機能の REST 契約。**両側が import する**ので React も Node も含めない */

export interface VocabItem {
  /** ファイルに書かれる値 (`[status:: progress]` の progress) */
  key: string
  /** 画面に出す言葉 */
  label: string
  /** その状態は「完了」か (チェックボックスと同期する) */
  done?: boolean
}

export interface TaskVocab {
  status: VocabItem[]
  priority: VocabItem[]
}

export interface TaskItem {
  path: string
  line: number
  checked: boolean
  text: string
  fields: Record<string, string>
}

/** 語彙を置く場所 (ADR-0029: 設定は vault の system/ に置く) */
export const VOCAB_PATH = 'system/settings.yaml'

export const tasksApi = {
  /** 語彙 (status / priority の取りうる値) */
  vocab: (): string => '/api/tasks/vocab',
  /** タスクの一覧。path を渡すとそのノートだけ */
  list: (path?: string): string =>
    path === undefined ? '/api/tasks' : `/api/tasks?path=${encodeURIComponent(path)}`,
  /** 1 行だけ書き換える (PATCH) */
  patch: (): string => '/api/tasks',
}
