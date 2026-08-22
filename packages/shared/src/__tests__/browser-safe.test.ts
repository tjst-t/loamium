/** @vitest-environment jsdom */
/**
 * `packages/shared` の index は **UI からも import される**。
 * Node 専用 API (`node:path` など) を持ち込むと、テストは Node 環境なので通るのに
 * ブラウザで画面が真っ白になる。実際に一度これで壊した (2026-08-21)。
 * jsdom で import して回帰を防ぐ。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import * as shared from '../index'

describe('shared のブラウザ安全性', () => {
  it('jsdom で import できる', () => {
    expect(typeof shared.roundTrip).toBe('function')
    expect(typeof shared.normalizeForSave).toBe('function')
    expect(typeof shared.normalizeVaultPath).toBe('function')
  })

  it('UI が使う関数が実際に動く', () => {
    expect(shared.normalizeVaultPath('/a//b.md')).toBe('a/b.md')
    expect(shared.roundTrip('# x\n')).toBe('# x\n')
    expect(shared.splitFrontmatter('---\na: 1\n---\n# x\n').frontmatter).toBe('---\na: 1\n---\n')
  })

  it('index から辿れるソースに node: の import が無い', () => {
    const root = dirname(new URL('../index.ts', import.meta.url).pathname)
    const seen = new Set<string>()
    const offenders: string[] = []
    const visit = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      let src: string
      try { src = readFileSync(file, 'utf8') } catch { return }
      for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1]
        if (spec === undefined) continue
        if (spec.startsWith('node:')) { offenders.push(`${file} → ${spec}`); continue }
        if (!spec.startsWith('.')) continue // npm パッケージは対象外
        const base = join(dirname(file), spec)
        for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
          try { readdirSync(dirname(cand)); visit(cand) } catch { /* noop */ }
        }
      }
    }
    visit(join(root, 'index.ts'))
    expect(offenders).toEqual([])
  })
})
