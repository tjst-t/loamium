/**
 * 不変条件 2 の gate を **Milkdown 実体** に対して回す。
 *
 * scripts/roundtrip-check.ts は packages/shared のプロセッサだけを検証する。
 * 実際にファイルへ書き戻すのはエディタなので、Milkdown の parser/serializer を
 * 通した経路にも同じ B (冪等性) / C (意味の保存) を課す。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { splitFrontmatter } from '@loamium/shared'
import { createMilkdownTransform, type MilkdownTransform } from '../milkdown-transform'

const CORPUS = resolve(__dirname, '../../../../server/src/samples')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.md')) out.push(p)
  }
  return out
}

const files = walk(CORPUS)

let tr: MilkdownTransform
let host: HTMLElement

beforeAll(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  tr = await createMilkdownTransform(host)
})
afterAll(async () => {
  await tr?.destroy()
  host?.remove()
})

/** Milkdown 経由の 1 往復 */
const trip = (body: string): string => tr.serialize(tr.parse(body))

describe('Milkdown 実体を通した round-trip', () => {
  it('コーパスが空でない', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  describe.each(files.map((f) => [f.slice(CORPUS.length + 1), f]))('%s', (_name, file) => {
    const src = readFileSync(file as string, 'utf8')
    const { body } = splitFrontmatter(src)

    // B: 一度正規化したら、二度目以降は変化しない
    it('B. 冪等性', () => {
      const once = trip(body)
      expect(trip(once)).toBe(once)
    })

    // C: 正規化してもドキュメント構造が変わらない
    it('C. 意味の保存', () => {
      const once = trip(body)
      expect(tr.parse(once).toJSON()).toEqual(tr.parse(body).toJSON())
    })
  })
})
