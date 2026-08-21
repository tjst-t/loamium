/**
 * gate の実効性を担保するための健全性チェックとメトリクス。
 *
 * B (冪等性) と C (意味の保存) は、パーサが空の doc を返していても自明に通ってしまう。
 * 「テストが緑」と「エディタが正しい」を取り違えないよう、
 * doc が実体を持つこと・Milkdown 経由の A を実測することをここで押さえる。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { splitFrontmatter } from '@loamium/shared'
import { createMilkdownTransform, type MilkdownTransform } from '../milkdown-transform'

const CORPUS = resolve(__dirname, '../../../../server/src/samples')
const walk = (d: string, o: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p, o)
    else if (e.endsWith('.md')) o.push(p)
  }
  return o
}
const files = walk(CORPUS)

let tr: MilkdownTransform
let host: HTMLElement
beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  tr = await createMilkdownTransform(host)
})
afterAll(async () => { await tr?.destroy(); host?.remove() })

describe('gate の健全性', () => {
  it('パーサが実体のある doc を返している (空 doc で B/C が自明に通るのを防ぐ)', () => {
    let totalNodes = 0
    let totalChars = 0
    for (const f of files) {
      const { body } = splitFrontmatter(readFileSync(f, 'utf8'))
      const doc = tr.parse(body)
      totalNodes += doc.childCount
      totalChars += doc.textContent.length
      // どのファイルも最低 1 ブロックは持つ
      expect(doc.childCount, `${f} の doc が空`).toBeGreaterThan(0)
    }
    expect(totalNodes).toBeGreaterThan(300)
    expect(totalChars).toBeGreaterThan(20000)
    process.stderr.write(`  [健全性] ${files.length} ファイル / 合計 ${totalNodes} ブロック / ${totalChars} 文字\n`)
  })

  it('壊れた入力では C が落ちる (assertion に効き目があることの確認)', () => {
    // 表セル内のエスケープを剥がすと再パースで列が増える = 意味が変わる
    const broken = '| a | b |\n| --- | --- |\n| x \\| y | z |\n'
    const stripped = broken.replace(/\\\|/g, '|')
    expect(tr.parse(stripped).toJSON()).not.toEqual(tr.parse(broken).toJSON())
  })

  it('A. Milkdown 経由の原文バイト一致率を実測する (報告のみ)', () => {
    let exact = 0
    for (const f of files) {
      const { body } = splitFrontmatter(readFileSync(f, 'utf8'))
      if (tr.serialize(tr.parse(body)) === body) exact++
    }
    const pct = ((exact / files.length) * 100).toFixed(1)
    process.stderr.write(`  [A] Milkdown 経由の原文バイト一致: ${exact}/${files.length} (${pct}%)\n`)
    expect(exact).toBeGreaterThanOrEqual(0)
  })
})
