import { parseDocument, Document, isMap, YAMLMap, Scalar } from 'yaml'
import { splitFrontmatter, joinFrontmatter } from './markdown/frontmatter'

/**
 * frontmatter のプロパティ (task #17)。
 *
 * frontmatter は **データモデルの第一級市民** (VISION / ADR-0035)。本文の doc には
 * 押し込まず、エディタ外のパネルで型付きで編集する。
 *
 * ⚠️ **書き換えは `yaml` の Document API を通す。** 読んで JS のオブジェクトにして
 * 書き直すと、コメント・引用符・並び・改行の書き方が全部作り直されて、1 つ値を
 * 変えただけで frontmatter 全体が diff に出る (git sync と 3-way merge が壊れる)。
 * Document を書き換えれば、触っていない行は原文のまま残る。
 */

export type PropertyType = 'text' | 'number' | 'date' | 'boolean' | 'list' | 'tags'

export interface Property {
  key: string
  type: PropertyType
  /** 表示・編集用の値。list / tags は文字列の配列、boolean は真偽、他は文字列 */
  value: string | number | boolean | string[] | null
}

/** `2026-08-23` / `2026-08-23T09:00` */
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/

/** 値の形から意味型を当てる。`tags` だけはキー名で決める (中身は普通の配列なので) */
export function inferType(key: string, value: unknown): PropertyType {
  if (key === 'tags' || key === 'tag') return 'tags'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string' && DATE.test(value)) return 'date'
  return 'text'
}

function toProperty(key: string, raw: unknown): Property {
  const type = inferType(key, raw)
  if (type === 'list' || type === 'tags') {
    const items = Array.isArray(raw)
      ? raw
      // `tags: 仕事, 読書` のような書き方も受ける (タグの扱いと揃える)
      : typeof raw === 'string' ? raw.split(',') : []
    return { key, type, value: items.map((item) => String(item).trim()).filter((item) => item !== '') }
  }
  if (type === 'boolean') return { key, type, value: raw === true }
  if (type === 'number') return { key, type, value: typeof raw === 'number' ? raw : Number(raw) }
  return { key, type, value: raw === null || raw === undefined ? null : String(raw) }
}

/** ノートの frontmatter を読む。順序は書かれている順のまま */
export function readProperties(content: string): Property[] {
  const { frontmatter } = splitFrontmatter(content)
  if (frontmatter === null) return []
  const doc = parseDocument(stripFences(frontmatter))
  if (!isMap(doc.contents)) return []
  const out: Property[] = []
  for (const item of doc.contents.items) {
    const key = String((item.key as Scalar | undefined)?.value ?? '')
    if (key === '') continue
    out.push(toProperty(key, item.value === null ? null : (item.value as Scalar).toJSON?.() ?? null))
  }
  return out
}

/** `---` で挟まれたブロックから中身だけ取り出す */
function stripFences(frontmatter: string): string {
  return frontmatter.replace(/^---\r?\n/, '').replace(/\r?\n---(\r?\n|$)$/, '\n')
}

/** 値を YAML に載せる形にする (型は UI が決める。ここで推測し直さない) */
function toYamlValue(type: PropertyType, value: Property['value']): unknown {
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : 0
    }
    case 'boolean': return value === true || value === 'true'
    case 'list':
    case 'tags': return Array.isArray(value) ? value : String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    default: return value === null ? null : String(value)
  }
}

export interface PropertyEdit {
  key: string
  /** 値を入れ替える (省略すると値はそのまま) */
  value?: { type: PropertyType; value: Property['value'] }
  /** キー名を変える (値は動かさない) */
  renameTo?: string
  /** キーごと消す */
  remove?: boolean
}

/**
 * frontmatter を書き換えた内容を返す。**本文には一切触らない。**
 * frontmatter が無いノートには新しく作る (空になったら `---` ごと消す)。
 */
export function applyPropertyEdit(content: string, edit: PropertyEdit): string {
  const { frontmatter, body } = splitFrontmatter(content)
  const doc = frontmatter === null ? new Document({}) : parseDocument(stripFences(frontmatter))
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap

  const map = doc.contents as YAMLMap
  if (edit.renameTo !== undefined && edit.renameTo !== edit.key) {
    const pair = map.items.find((item) => String((item.key as Scalar).value) === edit.key)
    // ⚠️ 消して足し直さない。順番が変わって diff が跳ねる
    if (pair !== undefined) (pair.key as Scalar).value = edit.renameTo
  }
  const key = edit.renameTo ?? edit.key
  if (edit.remove === true) map.delete(key)
  else if (edit.value !== undefined) map.set(key, doc.createNode(toYamlValue(edit.value.type, edit.value.value)))

  if (map.items.length === 0) return body
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, '')
  return joinFrontmatter({ frontmatter: `---\n${yaml}\n---\n`, body })
}

/** vault 全体で使われているキー (補完に使う)。多い順 */
export function countPropertyKeys(notes: readonly { content: string }[]): { key: string; type: PropertyType; count: number }[] {
  const seen = new Map<string, { key: string; type: PropertyType; count: number }>()
  for (const note of notes) {
    for (const property of readProperties(note.content)) {
      const found = seen.get(property.key)
      if (found === undefined) seen.set(property.key, { key: property.key, type: property.type, count: 1 })
      else found.count += 1
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ja'))
}
