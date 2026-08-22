/**
 * タグ `#tag` の抽出 (task #9)。**サーバーと UI で同じ規則を使う**ためここに置く。
 *
 * 本文中のインラインタグと frontmatter の `tags:` の両方を集める。
 * 記法は Obsidian 互換の範囲だけ (独自記法を増やさない)。
 */
import { splitFrontmatter } from './markdown/frontmatter'
import { maskCode } from './wikilink'

export interface TagRef {
  /** `#` を除いたタグ名 */
  tag: string
  /** 1 始まりの行番号 */
  line: number
  /** 元テキストでの位置 (`#` を含む) */
  start: number
  end: number
}

/** 比較用の畳み込み。タグは大小文字を区別しない */
export function foldTag(tag: string): string {
  return tag.normalize('NFC').toLowerCase()
}

/** `#` を落として整える */
export function normalizeTag(tag: string): string {
  return tag.normalize('NFC').replace(/^#+/, '').replace(/[/\s]+$/, '')
}

/**
 * インラインタグ。
 *
 * - 直前が文字・数字なら**タグではない** (`https://x/page#frag` を拾わないため)。
 *   日本語では `。#タグ` のように句読点の直後に書くので、境界は「空白」ではなく
 *   「英数字でない」で判定する
 * - `# 見出し` は空白があるのでタグにならない
 * - 数字だけ (`#1`) はタグにしない (Obsidian と同じ)
 * - `#親/子` の入れ子は 1 つのタグ
 */
const TAG_RE = /(?<![\p{L}\p{N}_/-])#([^\s#[\]{}()（）「」『』、。,.!?！？"'`|]+)/gu

export function parseInlineTags(text: string): TagRef[] {
  const masked = maskCode(text)
  const out: TagRef[] = []
  TAG_RE.lastIndex = 0
  for (let m = TAG_RE.exec(masked); m !== null; m = TAG_RE.exec(masked)) {
    const raw = m[1] ?? ''
    const tag = normalizeTag(raw)
    if (tag === '' || /^\d+$/.test(tag)) continue
    out.push({
      tag,
      line: masked.slice(0, m.index).split('\n').length,
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * frontmatter の `tags:`。
 *
 * ⚠️ **YAML パーサは入れていない。** 実際に使われる 3 つの書き方だけを読む:
 * `tags: [a, b]` / `tags: a, b` / ブロックシーケンス。読めない書き方は無視する
 * (frontmatter そのものは保存時に原文のまま復元されるので、読み落としても壊れない)。
 */
export function frontmatterTags(frontmatter: string | null): string[] {
  if (frontmatter === null) return []
  const lines = frontmatter.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(tags?|keywords)\s*:\s*(.*)$/i.exec(lines[i] ?? '')
    if (m === null) continue
    const inline = (m[2] ?? '').trim()
    if (inline !== '') {
      for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
        const tag = normalizeTag(part.trim().replace(/^["']|["']$/g, ''))
        if (tag !== '') out.push(tag)
      }
      continue
    }
    // ブロックシーケンス
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? ''
      if (/^-{3,}\s*$/.test(line)) break // frontmatter の終端
      const item = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (item === null) break
      const tag = normalizeTag((item[1] ?? '').replace(/^["']|["']$/g, ''))
      if (tag !== '') out.push(tag)
    }
  }
  return out
}

/** そのノートに付いているタグ (本文 + frontmatter)。重複は畳んで最初の表記を残す */
export function collectTags(content: string): string[] {
  const { frontmatter, body } = splitFrontmatter(content)
  const seen = new Map<string, string>()
  for (const tag of [...frontmatterTags(frontmatter), ...parseInlineTags(body).map((t) => t.tag)]) {
    if (!seen.has(foldTag(tag))) seen.set(foldTag(tag), tag)
  }
  return [...seen.values()]
}

export interface TagCount {
  tag: string
  count: number
}

/** vault 全体のタグを数える。多い順 → 名前順 */
export function countTags(notes: readonly { path: string; content: string }[]): TagCount[] {
  const counts = new Map<string, TagCount>()
  for (const note of notes) {
    for (const tag of collectTags(note.content)) {
      const key = foldTag(tag)
      const found = counts.get(key)
      if (found === undefined) counts.set(key, { tag, count: 1 })
      else found.count += 1
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'))
}

/** そのノートがタグを持っているか (親タグ `#親` は `#親/子` にも一致する) */
export function noteHasTag(content: string, tag: string): boolean {
  const wanted = foldTag(normalizeTag(tag))
  if (wanted === '') return false
  return collectTags(content).some((t) => {
    const folded = foldTag(t)
    return folded === wanted || folded.startsWith(`${wanted}/`)
  })
}
