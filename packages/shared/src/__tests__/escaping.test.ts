/** @vitest-environment node */
/**
 * エスケープの取り扱い。**一律で切っても、一律で残してもいけない**領域。
 *
 * - 切りすぎると内容が壊れる (表セルの `\|` を剥がして 2 列の表が 4 列に化けた)
 * - 残しすぎると記法が壊れる (`#tag` が `\#tag` に、`[[link]]` が `\[\[link]]` に化ける)
 *
 * どちらも実際に踏んだので、両方向をテストで固定する。
 */
import { describe, it, expect } from 'vitest'
import { roundTrip, parseMarkdown } from '../markdown/index'

const trip = (s: string): string => roundTrip(s).trim()

describe('エスケープを戻すべきもの (記法を壊さない)', () => {
  it.each([
    ['#sample-book の実データノート', '段落先頭のインラインタグ'],
    ['タグは #book と #sf', '行中のタグ'],
    ['[[WikiLink]] を書く', 'WikiLink'],
    ['> [!tip] callout', 'callout'],
    ['詳細は [[読書メモ 失敗の科学]] を参照', '日本語 WikiLink'],
  ])('%s は原文のまま (%s)', (src) => {
    expect(trip(src)).toBe(src.trim())
  })
})

describe('エスケープを維持すべきもの (意味を壊さない)', () => {
  it('表セル内の \\| は剥がさない (剥がすと列が増える)', () => {
    const src = '| a | b |\n| - | - |\n| x \\| y | z |\n'
    const out = roundTrip(src)
    expect(out).toContain('\\|')
    // 再パースして列数が変わらないこと
    expect(JSON.stringify(parseMarkdown(out))).toContain('tableCell')
    const cells = (JSON.stringify(parseMarkdown(out)).match(/tableCell/g) ?? []).length
    const before = (JSON.stringify(parseMarkdown(src)).match(/tableCell/g) ?? []).length
    expect(cells).toBe(before)
  })

  it('\\# + 空白 は見出しに化けさせない', () => {
    expect(trip('\\# 見出しではない')).toBe('\\# 見出しではない')
    expect(parseMarkdown(trip('\\# 見出しではない')).children[0]?.type).toBe('paragraph')
  })

  it('\\# 単体 は見出しに化けさせない', () => {
    expect(parseMarkdown(trip('\\#')).children[0]?.type).toBe('paragraph')
  })

  it('本物の見出しはそのまま', () => {
    expect(trip('# 見出し')).toBe('# 見出し')
    expect(parseMarkdown('# 見出し').children[0]?.type).toBe('heading')
  })
})
