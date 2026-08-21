/**
 * frontmatter は ProseMirror の doc に押し込まず、エディタ外のプロパティパネルで扱う
 * (VISION: frontmatter はデータモデルの第一級市民 / ADR-0035)。
 * そのため本文とは保存前に分離し、保存時に元の形のまま連結し直す。
 */
export interface SplitDocument {
  /** `---` を含む frontmatter ブロック全体。無ければ null */
  frontmatter: string | null
  /** frontmatter を除いた本文 */
  body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

export function splitFrontmatter(src: string): SplitDocument {
  const m = FRONTMATTER.exec(src)
  if (!m) return { frontmatter: null, body: src }
  return { frontmatter: m[0], body: src.slice(m[0].length) }
}

/** splitFrontmatter の逆。frontmatter の直後に空行を足さない (原文の書き方を保つ) */
export function joinFrontmatter(doc: SplitDocument): string {
  return doc.frontmatter === null ? doc.body : doc.frontmatter + doc.body
}
