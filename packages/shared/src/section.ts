/**
 * 見出しで区切った節の抽出 (task #13 の埋め込み `![[ノート#見出し]]` 用)。
 *
 * Markdown を構造として解析せず**行で切る**。埋め込みは「見せる」ためのもので、
 * 正本のファイルには一切触れないため、行単位で十分かつ壊れにくい。
 */
const HEADING = /^(#{1,6})\s+(.*)$/

export interface Section {
  heading: string
  level: number
  /** 見出し行を含まない本文 */
  body: string
}

/** 文書内の見出しを列挙する */
export function listSections(markdown: string): { heading: string; level: number }[] {
  const out: { heading: string; level: number }[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const mark = /^[ \t]*(```+|~~~+)/.exec(line)?.[1] ?? null
    if (fence === null && mark !== null) { fence = mark; continue }
    if (fence !== null) {
      if (mark !== null && mark[0] === fence[0] && mark.length >= fence.length) fence = null
      continue
    }
    const m = HEADING.exec(line)
    if (m !== null) out.push({ heading: (m[2] ?? '').trim(), level: (m[1] ?? '#').length })
  }
  return out
}

/** その見出しの節を取り出す。見つからなければ null */
export function extractSection(markdown: string, heading: string): Section | null {
  const wanted = heading.trim().normalize('NFC').toLowerCase()
  if (wanted === '') return null
  const lines = markdown.split('\n')
  let start = -1
  let level = 0
  let fence: string | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const mark = /^[ \t]*(```+|~~~+)/.exec(line)?.[1] ?? null
    if (fence === null && mark !== null) { fence = mark; continue }
    if (fence !== null) {
      if (mark !== null && mark[0] === fence[0] && mark.length >= fence.length) fence = null
      continue
    }
    const m = HEADING.exec(line)
    if (m === null) continue
    const text = (m[2] ?? '').trim()
    const depth = (m[1] ?? '#').length
    if (start < 0) {
      if (text.normalize('NFC').toLowerCase() !== wanted) continue
      start = i
      level = depth
      continue
    }
    // 次の「同じか上位」の見出しで終わり
    if (depth <= level) {
      return { heading: (lines[start] ?? '').replace(HEADING, '$2').trim(), level, body: lines.slice(start + 1, i).join('\n').trim() }
    }
  }
  if (start < 0) return null
  return {
    heading: (lines[start] ?? '').replace(HEADING, '$2').trim(),
    level,
    body: lines.slice(start + 1).join('\n').trim(),
  }
}
