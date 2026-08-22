/**
 * 全文検索のマッチング。**サーバーと UI で同じ規則を使う**ためここに置く
 * (UI はハイライト位置の算出に、サーバーは検索そのものに使う)。
 */

export interface SearchHit {
  /** vault 相対パス */
  path: string
  /** 1 始まりの行番号。ファイル名だけの一致なら 0 */
  line: number
  /** 該当行を抜き出したもの (前後は省略記号) */
  snippet: string
  /** snippet 内でのマッチ開始位置と長さ (UI のハイライト用) */
  match: { start: number; length: number }
  /** 並び順の根拠。title = ファイル名が一致 */
  kind: 'title' | 'body'
}

/** 大小文字と全角半角のゆれを吸収する。リンク・パス比較と同じく NFC を通す */
export function foldForSearch(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

const SNIPPET_BEFORE = 24
const SNIPPET_AFTER = 56

/** 該当行から前後を切り詰めたスニペットを作る */
export function makeSnippet(line: string, matchStart: number, matchLength: number): SearchHit['snippet'] {
  const from = Math.max(0, matchStart - SNIPPET_BEFORE)
  const to = Math.min(line.length, matchStart + matchLength + SNIPPET_AFTER)
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
}

/** スニペット内でのマッチ位置 (先頭の省略記号を数に入れる) */
function snippetMatchStart(matchStart: number): number {
  return matchStart <= SNIPPET_BEFORE ? matchStart : SNIPPET_BEFORE + 1
}

/**
 * 1 ファイル分の検索。**行単位で最初の一致だけ**返す (1 ファイルが結果を埋めないように)。
 * 索引を持たない素朴な走査だが、個人用 vault の規模では十分速い。
 */
export function searchNote(path: string, content: string, query: string): SearchHit[] {
  const needle = foldForSearch(query.trim())
  if (needle === '') return []

  const hits: SearchHit[] = []

  // ファイル名の一致は本文より上に出す (探し物はたいていノート名で覚えている)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const titleAt = foldForSearch(name).indexOf(needle)
  if (titleAt >= 0) {
    hits.push({
      path, line: 0, snippet: name, match: { start: titleAt, length: needle.length }, kind: 'title',
    })
  }

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const at = foldForSearch(line).indexOf(needle)
    if (at < 0) continue
    hits.push({
      path,
      line: i + 1,
      snippet: makeSnippet(line, at, needle.length),
      match: { start: snippetMatchStart(at), length: needle.length },
      kind: 'body',
    })
  }
  return hits
}

/** タイトル一致 → パス順 → 行順。安定した並びにする */
export function rankHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'title' ? -1 : 1
    if (a.path !== b.path) return a.path.localeCompare(b.path, 'ja')
    return a.line - b.line
  })
}
