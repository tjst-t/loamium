import { readProperties } from './properties'
import { collectTags, normalizeTag } from './tags'
import { parseTasks, type TaskLine } from './task'

/**
 * dataview 風クエリ (task #20 / ADR-0001)。
 *
 * ノートに書かれるのは **` ```dataview ` のコードフェンス**だけ。独自記法もブロック ID も
 * 使わない (Obsidian dataview の既存慣行にそのまま乗る)。ここはその**文字列を読んで
 * 結果を作る**ところで、ファイルには一切書き戻さない。
 *
 * 対応するのはサブセット: `LIST` / `TABLE` / `TASK` + `FROM` / `WHERE` / `SORT` / `LIMIT`。
 */

export type QueryKind = 'LIST' | 'TABLE' | 'TASK'

export interface QueryColumn {
  field: string
  /** `AS 見出し` を書いたときの表示名 */
  label: string
}

export type CompareOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains'

export interface Condition {
  field: string
  op: CompareOp
  value: string | number | boolean
  /** `WHERE !completed` のような否定 (op を持たない存在判定) */
  negated?: boolean
  /** 値を書かない存在判定 (`WHERE bookmark`) */
  exists?: boolean
}

export interface Source {
  kind: 'tag' | 'folder'
  value: string
}

export interface SortKey {
  field: string
  desc: boolean
}

export interface Query {
  kind: QueryKind
  columns: QueryColumn[]
  from: Source[]
  /** `FROM #a or #b` なら true (既定は and) */
  fromAny: boolean
  where: Condition[]
  sort: SortKey[]
  limit: number | null
}

export class QueryError extends Error {
  override readonly name = 'QueryError'
}

/** `"…"` を外す。数値・真偽はそのまま値にする */
function literal(token: string): string | number | boolean {
  const text = token.trim()
  if (/^"([\s\S]*)"$/.test(text) || /^'([\s\S]*)'$/.test(text)) return text.slice(1, -1)
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text)
  return text
}

/** キーワードで切る (大文字小文字は問わない。引用符の中は無視する) */
function sections(source: string): Map<string, string> {
  const keywords = ['from', 'where', 'sort', 'limit', 'group by']
  const out = new Map<string, string>()
  let current = 'head'
  let buffer = ''
  let quote: string | null = null
  const words = source.replace(/\s+/g, ' ').trim()
  let i = 0
  while (i < words.length) {
    const char = words[i] ?? ''
    if (quote !== null) {
      buffer += char
      if (char === quote) quote = null
      i += 1
      continue
    }
    if (char === '"' || char === "'") { quote = char; buffer += char; i += 1; continue }
    const rest = words.slice(i).toLowerCase()
    const found = keywords.find((keyword) =>
      rest.startsWith(`${keyword} `) && (i === 0 || words[i - 1] === ' '))
    if (found !== undefined) {
      out.set(current, buffer.trim())
      current = found
      buffer = ''
      i += found.length + 1
      continue
    }
    buffer += char
    i += 1
  }
  out.set(current, buffer.trim())
  return out
}

/** 引用符を尊重してカンマで割る */
function splitList(text: string): string[] {
  const out: string[] = []
  let buffer = ''
  let quote: string | null = null
  for (const char of text) {
    if (quote !== null) {
      buffer += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; buffer += char; continue }
    if (char === ',') { out.push(buffer.trim()); buffer = ''; continue }
    buffer += char
  }
  if (buffer.trim() !== '') out.push(buffer.trim())
  return out
}

const OPS: CompareOp[] = ['>=', '<=', '!=', '=', '>', '<']

function parseCondition(text: string): Condition {
  const contains = /^(.+?)\s+contains\s+(.+)$/i.exec(text)
  if (contains !== null) {
    return { field: (contains[1] ?? '').trim(), op: 'contains', value: literal(contains[2] ?? '') }
  }
  for (const op of OPS) {
    const at = text.indexOf(op)
    if (at <= 0) continue
    return {
      field: text.slice(0, at).trim(),
      op,
      value: literal(text.slice(at + op.length)),
    }
  }
  // `WHERE bookmark` / `WHERE !completed` — 値の無い存在判定
  const negated = text.startsWith('!')
  return { field: (negated ? text.slice(1) : text).trim(), op: '=', value: true, exists: true, negated }
}

export function parseQuery(source: string): Query {
  const parts = sections(source)
  const head = (parts.get('head') ?? '').trim()
  const kindWord = head.split(' ')[0]?.toUpperCase() ?? ''
  if (kindWord !== 'LIST' && kindWord !== 'TABLE' && kindWord !== 'TASK') {
    throw new QueryError(`最初の語は LIST / TABLE / TASK のどれかです: ${head === '' ? '(空)' : head}`)
  }
  const kind: QueryKind = kindWord

  const columns = splitList(head.slice(kindWord.length).trim()).map((entry): QueryColumn => {
    const as = /^(.+?)\s+as\s+(.+)$/i.exec(entry)
    if (as === null) return { field: entry, label: entry }
    return { field: (as[1] ?? '').trim(), label: literal(as[2] ?? '').toString() }
  })
  if (kind === 'TABLE' && columns.length === 0) {
    throw new QueryError('TABLE には列が要ります (例: TABLE status, rating)')
  }

  const fromText = parts.get('from') ?? ''
  const fromAny = /\s+or\s+/i.test(fromText)
  const from = fromText
    .split(/\s+(?:and|or)\s+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry): Source => (entry.startsWith('#')
      ? { kind: 'tag', value: normalizeTag(entry) }
      : { kind: 'folder', value: String(literal(entry)) }))

  const where = (parts.get('where') ?? '')
    .split(/\s+and\s+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(parseCondition)

  const sort = splitList(parts.get('sort') ?? '').map((entry): SortKey => {
    const [field = '', direction = ''] = entry.split(/\s+/)
    return { field, desc: direction.toUpperCase() === 'DESC' }
  })

  const limitText = parts.get('limit') ?? ''
  const limit = limitText === '' || Number.isNaN(Number(limitText)) ? null : Number(limitText)

  return { kind, columns, from, fromAny, where, sort, limit }
}

/** クエリにかけるノート 1 枚 */
export interface QueryNote {
  path: string
  content: string
  /** ISO 8601。file.mtime の並べ替えに使う */
  mtime?: string
}

export type FieldValue = string | number | boolean | string[] | null

export interface QueryRow {
  path: string
  /** 表示名 (frontmatter の title、無ければファイル名) */
  title: string
  /** TABLE の列 (列の順そのまま) */
  values: FieldValue[]
  /** TASK の行 */
  task?: { line: number; checked: boolean; text: string; fields: Record<string, string> }
}

export interface QueryResult {
  kind: QueryKind
  columns: string[]
  rows: QueryRow[]
  /** 走査したノートの数 (「0 件」の理由を説明するために出す) */
  scanned: number
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** ノート 1 枚のフィールド。frontmatter のキーと `file.*` を引ける */
function noteField(note: QueryNote, field: string, properties: Map<string, FieldValue>): FieldValue {
  switch (field.toLowerCase()) {
    case 'file.name': return baseName(note.path)
    case 'file.path': return note.path
    case 'file.folder': return folderOf(note.path)
    case 'file.link': return `[[${baseName(note.path)}]]`
    case 'file.mtime': return note.mtime ?? null
    case 'file.tags': return collectTags(note.content)
    default: return properties.get(field) ?? null
  }
}

/** タスク行のフィールド。ノートのフィールドも引ける (`file.name` など) */
function taskField(
  note: QueryNote, task: TaskLine, field: string, properties: Map<string, FieldValue>,
): FieldValue {
  const lower = field.toLowerCase()
  if (lower === 'text') return task.text
  if (lower === 'completed' || lower === 'checked') return task.checked
  const inline = task.fields[field]
  if (inline !== undefined) return inline
  return noteField(note, field, properties)
}

function compare(left: FieldValue, op: CompareOp, right: string | number | boolean): boolean {
  if (op === 'contains') {
    const needle = String(right)
    if (Array.isArray(left)) return left.map((item) => normalizeTag(item)).includes(normalizeTag(needle))
      || left.includes(needle)
    return String(left ?? '').includes(needle)
  }
  if (op === '=' || op === '!=') {
    const same = Array.isArray(left)
      ? left.includes(String(right))
      : String(left ?? '') === String(right) || left === right
    return op === '=' ? same : !same
  }
  // 大小比較は数値どうし、無理なら文字列で
  const a = typeof left === 'number' ? left : Number(left)
  const b = typeof right === 'number' ? right : Number(right)
  const numeric = !Number.isNaN(a) && !Number.isNaN(b)
  const x = numeric ? a : String(left ?? '')
  const y = numeric ? b : String(right)
  if (op === '>') return x > y
  if (op === '<') return x < y
  if (op === '>=') return x >= y
  return x <= y
}

const truthy = (value: FieldValue): boolean =>
  value !== null && value !== false && value !== '' && !(Array.isArray(value) && value.length === 0)

function matchesSource(note: QueryNote, query: Query, tags: string[]): boolean {
  if (query.from.length === 0) return true
  const hit = (source: Source): boolean => (source.kind === 'tag'
    ? tags.some((tag) => tag === source.value || tag.startsWith(`${source.value}/`))
    : note.path === source.value || note.path.startsWith(`${source.value}/`))
  return query.fromAny ? query.from.some(hit) : query.from.every(hit)
}

function sortRows(rows: QueryRow[], keys: SortKey[], valueOf: (row: QueryRow, field: string) => FieldValue): void {
  if (keys.length === 0) return
  rows.sort((a, b) => {
    for (const key of keys) {
      const left = valueOf(a, key.field)
      const right = valueOf(b, key.field)
      if (left === right) continue
      const numeric = typeof left === 'number' && typeof right === 'number'
      const order = numeric
        ? (left as number) - (right as number)
        : String(left ?? '').localeCompare(String(right ?? ''), 'ja')
      if (order !== 0) return key.desc ? -order : order
    }
    return 0
  })
}

/**
 * クエリを走らせる。**ファイルには触らない** (読むだけ)。
 * 索引を持たず毎回ノートを走査するので、外部エディタやエージェントの書き込み直後でも最新になる。
 */
export function runQuery(query: Query, notes: readonly QueryNote[]): QueryResult {
  const rows: QueryRow[] = []
  const cache = new Map<string, Map<string, FieldValue>>()

  const propsOf = (note: QueryNote): Map<string, FieldValue> => {
    const found = cache.get(note.path)
    if (found !== undefined) return found
    const map = new Map<string, FieldValue>()
    for (const property of readProperties(note.content)) map.set(property.key, property.value)
    cache.set(note.path, map)
    return map
  }

  for (const note of notes) {
    const properties = propsOf(note)
    if (!matchesSource(note, query, collectTags(note.content))) continue
    const titleValue = properties.get('title')
    const title = typeof titleValue === 'string' && titleValue !== '' ? titleValue : baseName(note.path)

    if (query.kind === 'TASK') {
      for (const task of parseTasks(note.content)) {
        const value = (field: string): FieldValue => taskField(note, task, field, properties)
        if (!query.where.every((cond) => (cond.exists === true
          ? truthy(value(cond.field)) !== (cond.negated === true)
          : compare(value(cond.field), cond.op, cond.value)))) continue
        rows.push({
          path: note.path,
          title,
          values: query.columns.map((column) => value(column.field)),
          task: { line: task.line, checked: task.checked, text: task.text, fields: task.fields },
        })
      }
      continue
    }

    const value = (field: string): FieldValue => noteField(note, field, properties)
    if (!query.where.every((cond) => (cond.exists === true
      ? truthy(value(cond.field)) !== (cond.negated === true)
      : compare(value(cond.field), cond.op, cond.value)))) continue
    rows.push({ path: note.path, title, values: query.columns.map((column) => value(column.field)) })
  }

  sortRows(rows, query.sort, (row, field) => {
    const note = notes.find((entry) => entry.path === row.path)
    if (note === undefined) return null
    const properties = propsOf(note)
    if (row.task !== undefined) {
      const task = parseTasks(note.content).find((entry) => entry.line === row.task?.line)
      if (task !== undefined) return taskField(note, task, field, properties)
    }
    return noteField(note, field, properties)
  })

  return {
    kind: query.kind,
    columns: query.columns.map((column) => column.label),
    rows: query.limit === null ? rows : rows.slice(0, query.limit),
    scanned: notes.length,
  }
}
