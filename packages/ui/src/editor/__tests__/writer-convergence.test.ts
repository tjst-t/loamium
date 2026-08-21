/**
 * 2 つの書き手が同じ正規形に収束することを検証する。
 *
 * Loamium ではファイルを書き戻す経路が 2 つある:
 *   1. エディタ (Milkdown の serializer)
 *   2. サーバー / CLI の fmt・エージェント書き込み (packages/shared)
 *
 * 両者の serializer は別物なので、素のままだと正規形が食い違い、
 * 片方が保存 → もう片方が書き直す、で **git の diff が永久に振動する**。
 * 不変条件 2 が最終的に守りたいのはこれなので、独立した gate として課す。
 *
 * 収束の担保は `normalizeForSave` への一本化で行う (エディタの保存経路がこれを通す)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { splitFrontmatter, roundTrip as sharedTrip, normalizeForSave } from '@loamium/shared'
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

/** エディタの保存経路そのもの: Milkdown で往復 → shared で正規化 */
const saveViaEditor = (body: string): string => normalizeForSave(tr.serialize(tr.parse(body)))

describe.each(files.map((f) => [f.slice(CORPUS.length + 1), f]))('%s', (_name, file) => {
  const { body } = splitFrontmatter(readFileSync(file as string, 'utf8'))

  it('エディタで開いて保存し直しても、二度目以降は 1 バイトも動かない', () => {
    const once = saveViaEditor(body)
    expect(saveViaEditor(once)).toBe(once)
  })

  it('エディタが保存したものを shared (サーバー/CLI) が触っても動かない', () => {
    const once = saveViaEditor(body)
    expect(sharedTrip(once)).toBe(once)
  })

  it('エディタ由来の <br /> がファイルに混入しない', () => {
    expect(saveViaEditor(body)).not.toContain('<br />')
  })
})
