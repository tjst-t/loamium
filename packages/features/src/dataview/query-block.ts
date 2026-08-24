import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { apiJson } from '@loamium/ui/src/api'
import { getEditorEnv } from '@loamium/ui/src/editor/editor-env'
import { tasksApi } from '@loamium/features/tasks/contract'
import { dataviewApi, QUERY_LANG, type QueryResponse, type QueryResult } from './contract'

/**
 * クエリブロックの描画 (task #20)。
 *
 * **スキーマも serializer も触らない。** ファイルにあるのは ` ```dataview ` の
 * コードフェンスそのままで、その下に結果を widget decoration で添える
 * (mermaid と同じ作り)。カーソルをフェンスに入れればクエリを直せる。
 */

interface Found {
  /** フェンスノードの位置 */
  pos: number
  to: number
  source: string
}

function queriesIn(state: EditorState): Found[] {
  const out: Found[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true
    const language = String(node.attrs['language'] ?? '')
    if (language.toLowerCase() !== QUERY_LANG) return false
    out.push({ pos, to: pos + node.nodeSize, source: node.textContent })
    return false
  })
  return out
}

/** クエリ文字列 → 結果。同じ文字列は使い回す (打つたびに投げない) */
const cache = new Map<string, QueryResponse>()
const pending = new Set<string>()

/** ファイルが変わったら結果は古い。保存やノート切り替えのたびに捨てる */
export function forgetQueries(): void {
  cache.clear()
}

function openNote(path: string): void {
  getEditorEnv().open(path)
}

/** `[[リンク]]` は表示名だけにする (結果は読むためのもの) */
const plain = (text: string): string =>
  text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, alias?: string) => alias ?? target)

/** ISO の日時は読める形にする (`2026-08-23T04:24:05.356Z` のまま出さない) */
function show(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => show(item)).join(', ')
  const text = String(value ?? '')
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text)
  if (iso === null) return plain(text)
  return `${iso[1] ?? ''}-${iso[2] ?? ''}-${iso[3] ?? ''} ${iso[4] ?? ''}:${iso[5] ?? ''}`
}

function renderList(result: QueryResult, box: HTMLElement): void {
  const list = document.createElement('ul')
  list.className = 'query-list'
  for (const row of result.rows) {
    const item = document.createElement('li')
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'query-link'
    link.textContent = row.title
    link.title = row.path
    link.addEventListener('mousedown', (event) => { event.preventDefault(); openNote(row.path) })
    item.append(link)
    list.append(item)
  }
  box.append(list)
}

function renderTable(result: QueryResult, box: HTMLElement): void {
  const table = document.createElement('table')
  table.className = 'query-table'
  const head = document.createElement('tr')
  for (const label of ['ノート', ...result.columns]) {
    const th = document.createElement('th')
    th.textContent = label
    head.append(th)
  }
  table.append(head)
  for (const row of result.rows) {
    const tr = document.createElement('tr')
    const first = document.createElement('td')
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'query-link'
    link.textContent = row.title
    link.title = row.path
    link.addEventListener('mousedown', (event) => { event.preventDefault(); openNote(row.path) })
    first.append(link)
    tr.append(first)
    for (const value of row.values) {
      const td = document.createElement('td')
      td.textContent = show(value)
      tr.append(td)
    }
    table.append(tr)
  }
  box.append(table)
}

function renderTasks(view: EditorView, result: QueryResult, box: HTMLElement): void {
  const list = document.createElement('ul')
  list.className = 'query-tasks'
  for (const row of result.rows) {
    const task = row.task
    if (task === undefined) continue
    const item = document.createElement('li')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = task.checked
    // ⚠️ **元のファイルを書き換える。** ここで押したチェックは、そのノートの
    //    その行に入る (tasks 機能の PATCH を通すので完了と status の同期も効く)
    check.addEventListener('change', () => {
      void apiJson(tasksApi.patch(), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: row.path, line: task.line, checked: check.checked }),
      }).then(() => {
        forgetQueries()
        if (!view.isDestroyed) view.dispatch(view.state.tr)
      }, () => { check.checked = task.checked })
    })
    const label = document.createElement('span')
    label.className = 'query-task-text'
    label.textContent = plain(task.text)
    const where = document.createElement('button')
    where.type = 'button'
    where.className = 'query-link is-source'
    where.textContent = row.title
    where.title = row.path
    where.addEventListener('mousedown', (event) => { event.preventDefault(); openNote(row.path) })
    item.append(check, label, where)
    list.append(item)
  }
  box.append(list)
}

function resultFor(view: EditorView, source: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'query-result'
  box.contentEditable = 'false'

  const found = cache.get(source)
  if (found === undefined) {
    box.classList.add('is-loading')
    box.textContent = '数えています…'
    if (!pending.has(source)) {
      pending.add(source)
      apiJson<QueryResponse>(dataviewApi.run(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: source }),
      }).then((response) => {
        cache.set(source, response)
      }, () => {
        cache.set(source, { error: 'クエリを実行できませんでした' })
      }).finally(() => {
        pending.delete(source)
        if (!view.isDestroyed) view.dispatch(view.state.tr)
      })
    }
    return box
  }

  if (found.error !== undefined || found.result === undefined) {
    // ⚠️ 書き方が違っても黙って空にしない (なぜ 0 件なのかが分からなくなる)
    box.classList.add('is-broken')
    box.textContent = found.error ?? 'クエリを実行できませんでした'
    return box
  }

  const result = found.result
  const count = document.createElement('div')
  count.className = 'query-count'
  count.textContent = `${String(result.rows.length)} 件`
  box.append(count)
  if (result.rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'query-empty'
    empty.textContent = `当てはまるものはありません (${String(result.scanned)} 件を見ました)`
    box.append(empty)
    return box
  }
  if (result.kind === 'TABLE') renderTable(result, box)
  else if (result.kind === 'TASK') renderTasks(view, result, box)
  else renderList(result, box)
  return box
}

const queryPlugin = new Plugin({
  key: new PluginKey('loamium-dataview'),
  view() {
    // ノートを開き直した / 保存した = 中身が変わったかもしれない。結果は取り直す
    forgetQueries()
    return {}
  },
  props: {
    decorations(state) {
      const decorations: Decoration[] = []
      for (const found of queriesIn(state)) {
        const response = cache.get(found.source)
        // ⚠️ key に**中身の段階**まで入れる。入れないと「数えています…」の DOM が
        //    使い回されて、結果が届いても止まったままになる (embed / mermaid と同じ罠)
        const phase = response === undefined ? 'loading' : response.error === undefined ? 'ready' : 'broken'
        decorations.push(Decoration.widget(found.to, (view) => resultFor(view, found.source), {
          side: 1,
          key: `query-${String(found.pos)}-${phase}-${found.source}`,
          ignoreSelection: true,
        }))
      }
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

export const queryBlock = [$prose(() => queryPlugin)]
