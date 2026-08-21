/**
 * 不変条件 2 (round-trip 保存性) の CI gate。
 *
 * 3 段階で測る:
 *   A. 原文バイト一致  — 任意の Markdown をそのまま保存できるか (報告のみ・gate しない)
 *   B. 冪等性          — 一度正規化した後は二度と変化しないか  ← **hard gate**
 *   C. 意味の保存      — 正規化で mdast が変化しないか          ← **hard gate**
 *
 * B と C が通れば「vault を一度 fmt すれば、以後 1 文字編集の diff は 1 行で済む」が保証される。
 * A は 100% が理想だが、達成コストが高く、B/C が通っていれば git sync は壊れない。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { roundTrip, parseMarkdown } from '../packages/shared/src/markdown/index'

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.md')) out.push(p)
  }
  return out
}

/** position は行番号を含むため、意味比較からは落とす */
function stripPosition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPosition)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'position') continue
      out[k] = stripPosition(v)
    }
    return out
  }
  return value
}

function classify(a: string, b: string): string {
  if (/^\s*\|\s*-+/.test(a) && /^\s*\|\s*-+/.test(b)) return 'テーブル区切り行の幅'
  if (b.replace(/\\/g, '') === a) return 'エスケープ追加 (CJK 隣接の強調など)'
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return 'インデント/空白'
  if (a.includes('|') && b.includes('|')) return 'テーブル桁揃え'
  return 'その他'
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: roundtrip-check <dir...>')
  process.exit(2)
}

const files = roots.flatMap((r) => walk(r))
let exact = 0
const idemFail: string[] = []
const semFail: string[] = []
const kinds = new Map<string, number>()

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const once = roundTrip(src)
  const twice = roundTrip(once)

  if (src === once) exact++
  else {
    const A = src.split('\n'), B = once.split('\n')
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const a = A[i], b = B[i]
      if (a === undefined || b === undefined || a === b) continue
      const k = classify(a, b)
      kinds.set(k, (kinds.get(k) ?? 0) + 1)
    }
  }
  if (once !== twice) idemFail.push(f)
  const before = JSON.stringify(stripPosition(parseMarkdown(src)))
  const after = JSON.stringify(stripPosition(parseMarkdown(once)))
  if (before !== after) semFail.push(f)
}

const pct = (n: number): string => `${((n / files.length) * 100).toFixed(1)}%`
console.log(`\n=== round-trip 保存性 (${files.length} ファイル) ===`)
console.log(`  A. 原文バイト一致 (報告のみ) : ${exact}/${files.length}  ${pct(exact)}`)
console.log(`  B. 冪等性         (gate)     : ${files.length - idemFail.length}/${files.length}  ${pct(files.length - idemFail.length)}`)
console.log(`  C. 意味の保存     (gate)     : ${files.length - semFail.length}/${files.length}  ${pct(files.length - semFail.length)}`)

if (kinds.size > 0) {
  console.log('\n--- A が崩れる原因 (行数) ---')
  for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`)
  }
}
for (const [label, list] of [['冪等性', idemFail], ['意味の保存', semFail]] as const) {
  if (list.length > 0) {
    console.log(`\n❌ ${label} 違反:`)
    for (const f of list) console.log(`     ${f}`)
  }
}

const failed = idemFail.length + semFail.length
console.log(failed === 0 ? '\n✅ gate 通過 (B / C)\n' : `\n❌ gate 失敗\n`)
process.exit(failed === 0 ? 0 : 1)
