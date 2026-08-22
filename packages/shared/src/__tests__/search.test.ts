/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { foldForSearch, makeSnippet, rankHits, searchNote } from '../search'

describe('検索のマッチング', () => {
  it('本文の一致を行番号つきで返す', () => {
    const hits = searchNote('a.md', '# 見出し\n\n監査ログの話\n別の行\n', '監査ログ')
    expect(hits).toEqual([{
      path: 'a.md', line: 3, snippet: '監査ログの話',
      match: { start: 0, length: 4 }, kind: 'body',
    }])
  })

  it('ファイル名の一致は kind=title、行番号 0 で返す', () => {
    const hits = searchNote('projects/監査ログ.md', '本文には無い\n', '監査')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'title', line: 0, snippet: '監査ログ.md' })
  })

  it('同じファイルの複数行をすべて返す', () => {
    const hits = searchNote('a.md', 'foo\nbar\nfoo\n', 'foo')
    expect(hits.map((h) => h.line)).toEqual([1, 3])
  })

  it('大文字小文字を区別しない', () => {
    expect(searchNote('a.md', 'Hello World\n', 'hello world')).toHaveLength(1)
    expect(searchNote('a.md', 'hello\n', 'HELLO')).toHaveLength(1)
  })

  it('NFC 正規化を通す (濁点の合成ゆれを吸収する)', () => {
    // "ガ" の合成済み (U+30AC) と分解形 (U+30AB U+3099)
    expect(foldForSearch('ガ')).toBe(foldForSearch('が'.replace('か', 'カ')))
    expect(searchNote('a.md', 'ガラス\n', 'ガラス')).toHaveLength(1)
  })

  it('空のクエリは何も返さない', () => {
    expect(searchNote('a.md', 'なんでもある\n', '   ')).toEqual([])
  })

  it('長い行はスニペットに切り詰め、省略記号を付ける', () => {
    const line = `${'あ'.repeat(60)}目印${'い'.repeat(80)}`
    const hits = searchNote('a.md', `${line}\n`, '目印')
    const snippet = hits[0]?.snippet ?? ''
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThan(line.length)
    // ハイライト位置がスニペット内の「目印」を指している
    const { start, length } = hits[0]?.match ?? { start: 0, length: 0 }
    expect(snippet.slice(start, start + length)).toBe('目印')
  })

  it('短い行はそのまま。ハイライト位置がずれない', () => {
    const hits = searchNote('a.md', '短い行に目印がある\n', '目印')
    const { snippet, match } = hits[0] ?? { snippet: '', match: { start: 0, length: 0 } }
    expect(snippet).toBe('短い行に目印がある')
    expect(snippet.slice(match.start, match.start + match.length)).toBe('目印')
  })

  it('makeSnippet は単体でも同じ規則で切る', () => {
    expect(makeSnippet('abc', 0, 1)).toBe('abc')
  })
})

describe('並び順', () => {
  it('タイトル一致 → パス順 → 行順', () => {
    const ranked = rankHits([
      { path: 'b.md', line: 5, snippet: '', match: { start: 0, length: 1 }, kind: 'body' },
      { path: 'b.md', line: 2, snippet: '', match: { start: 0, length: 1 }, kind: 'body' },
      { path: 'z.md', line: 0, snippet: '', match: { start: 0, length: 1 }, kind: 'title' },
      { path: 'a.md', line: 1, snippet: '', match: { start: 0, length: 1 }, kind: 'body' },
    ])
    expect(ranked.map((h) => `${h.path}:${h.line}`)).toEqual(['z.md:0', 'a.md:1', 'b.md:2', 'b.md:5'])
  })
})
