/**
 * WikiLink `[[…]]` の解析と解決。**サーバーと UI で同じ規則を使う**ためここに置く
 * (UI は表示と補完に、サーバーはバックリンクとリネーム追従に使う)。
 *
 * 記法は Obsidian 互換の範囲だけを扱う (独自記法を増やさない):
 *   [[ノート]] / [[フォルダ/ノート]] / [[ノート#見出し]] / [[ノート|表示名]]
 */
import { normalizeVaultPath } from './vault-path'

export interface WikiLink {
  /** `[[` から `]]` までそのまま (埋め込みなら先頭の `!` も含む) */
  raw: string
  /** `![[…]]` の埋め込みか (task #13) */
  embed: boolean
  /** リンク先の指定 (`#`・`|` より前) */
  target: string
  /** `#` の後ろ。無ければ null */
  heading: string | null
  /** `|` の後ろ。無ければ null */
  alias: string | null
  /** 元テキスト内での位置 */
  start: number
  end: number
}

/** 比較用の畳み込み。パス比較は NFC + 小文字化で行う (CLAUDE.md: リンク比較は NFC) */
export function foldTarget(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

const LINK_RE = /\[\[([^[\]\n|#]*)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/g

/**
 * コード領域 (フェンス・インラインコード) を伏せた複製を作る。
 *
 * ⚠️ **コードの中の `[[…]]` はリンクではない。** リネーム追従がここを書き換えると、
 * サンプルコードや説明文が壊れる。位置をずらさないよう同じ長さの空白で潰す。
 */
export function maskCode(text: string): string {
  const blank = (line: string): string => line.replace(/[^\n]/g, ' ')
  let fence: string | null = null
  return text.split('\n').map((line) => {
    const mark = /^[ \t]*(```+|~~~+)/.exec(line)?.[1] ?? null
    if (fence === null) {
      if (mark !== null) { fence = mark; return blank(line) }
      // インラインコードだけ潰す
      return line.replace(/`+[^`]*`+/g, blank)
    }
    // フェンスの中。同じ種類で同じ長さ以上のマークが来たら閉じる
    if (mark !== null && mark[0] === fence[0] && mark.length >= fence.length) fence = null
    return blank(line)
  }).join('\n')
}

/** 本文中の `[[…]]` をすべて拾う。コード領域は除外する */
export function parseWikiLinks(text: string): WikiLink[] {
  const masked = maskCode(text)
  const links: WikiLink[] = []
  LINK_RE.lastIndex = 0
  for (let m = LINK_RE.exec(masked); m !== null; m = LINK_RE.exec(masked)) {
    const target = (m[1] ?? '').trim()
    if (target === '') continue
    // 直前が `!` なら埋め込み (`![[ノート]]`)
    const embed = m.index > 0 && masked[m.index - 1] === '!'
    const start = embed ? m.index - 1 : m.index
    links.push({
      raw: text.slice(start, m.index + m[0].length),
      embed,
      target,
      heading: m[2] === undefined ? null : m[2].trim(),
      alias: m[3] === undefined ? null : m[3].trim(),
      start,
      end: m.index + m[0].length,
    })
  }
  return links
}

/** リンク先指定を比較用に整える (`./` と `.md` を落とす) */
function normalizeTarget(target: string): string {
  const trimmed = target.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return trimmed.replace(/\.md$/i, '')
}

const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * リンク先を vault パスへ解決する。見つからなければ null (= 壊れリンク)。
 *
 * 優先順位: パス一致 → ノート名一致。同点なら「リンク元と同じフォルダ」→ 浅い階層 → 名前順。
 * `from` (リンク元のパス) は同じフォルダを優先するためだけに使う。
 */
export function resolveWikiLink(target: string, knownPaths: readonly string[], from?: string): string | null {
  const wanted = foldTarget(normalizeTarget(target))
  if (wanted === '') return null

  const byPath: string[] = []
  const byName: string[] = []
  for (const path of knownPaths) {
    if (foldTarget(path.replace(/\.md$/i, '')) === wanted) byPath.push(path)
    else if (foldTarget(baseNameOf(path)) === wanted) byName.push(path)
  }
  const candidates = byPath.length > 0 ? byPath : byName
  if (candidates.length === 0) return null

  const fromDir = from === undefined ? null : dirOf(from)
  const score = (path: string): number => (fromDir !== null && dirOf(path) === fromDir ? 0 : 1)
  return [...candidates].sort((a, b) =>
    score(a) - score(b)
    || a.split('/').length - b.split('/').length
    || a.localeCompare(b, 'ja'))[0] ?? null
}

/**
 * そのノートを指すのに使う「短いほうの書き方」を返す。
 * ノート名が vault 内で一意ならノート名だけ、重複するならフォルダ付きのパス。
 */
export function preferredWikiTarget(path: string, knownPaths: readonly string[]): string {
  const name = baseNameOf(path)
  const sameName = knownPaths.filter((p) => foldTarget(baseNameOf(p)) === foldTarget(name))
  return sameName.length <= 1 ? name : path.replace(/\.md$/i, '')
}

/** `[[…]]` を組み立て直す (見出し・表示名・埋め込みの `!` は保つ) */
export function formatWikiLink(
  target: string, heading: string | null, alias: string | null, embed = false,
): string {
  const head = heading === null || heading === '' ? '' : `#${heading}`
  const name = alias === null || alias === '' ? '' : `|${alias}`
  return `${embed ? '!' : ''}[[${target}${head}${name}]]`
}

/**
 * 本文中の `[[…]]` を書き換える。`replace` が null を返したリンクはそのまま。
 * コード領域には手を触れない (`parseWikiLinks` がそもそも拾わない)。
 */
export function rewriteWikiLinks(text: string, replace: (link: WikiLink) => string | null): string {
  const links = parseWikiLinks(text)
  if (links.length === 0) return text
  let out = ''
  let at = 0
  for (const link of links) {
    const next = replace(link)
    if (next === null) continue
    out += text.slice(at, link.start) + formatWikiLink(next, link.heading, link.alias, link.embed)
    at = link.end
  }
  return out + text.slice(at)
}

export interface Backlink {
  /** リンク元のノート */
  path: string
  /** 1 始まりの行番号 */
  line: number
  /** その行そのもの */
  snippet: string
  /** リンクの書き方 (`[[…]]` 全体) */
  raw: string
}

/**
 * `target` を指しているリンクを本文から拾う。
 * 解決結果で判定するので、`[[ノート]]` でも `[[フォルダ/ノート]]` でも同じように見つかる。
 */
export function findBacklinksIn(
  sourcePath: string,
  content: string,
  targetPath: string,
  knownPaths: readonly string[],
): Backlink[] {
  const wanted = normalizeVaultPath(targetPath)
  const out: Backlink[] = []
  for (const link of parseWikiLinks(content)) {
    if (resolveWikiLink(link.target, knownPaths, sourcePath) !== wanted) continue
    const line = content.slice(0, link.start).split('\n').length
    out.push({
      path: sourcePath,
      line,
      snippet: (content.split('\n')[line - 1] ?? '').trim(),
      raw: link.raw,
    })
  }
  return out
}
