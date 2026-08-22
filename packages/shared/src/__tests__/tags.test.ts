import { describe, it, expect } from 'vitest'
import { collectTags, countTags, frontmatterTags, noteHasTag, parseInlineTags } from '../tags'

describe('parseInlineTags', () => {
  it('本文中の #タグ を拾う', () => {
    expect(parseInlineTags('今日は #仕事 と #読書/SF をした').map((t) => t.tag))
      .toEqual(['仕事', '読書/SF'])
  })

  it('行頭のタグも拾う', () => {
    expect(parseInlineTags('#メモ\n本文').map((t) => t.tag)).toEqual(['メモ'])
  })

  it('見出しはタグではない', () => {
    expect(parseInlineTags('# 見出し\n## 小見出し')).toEqual([])
  })

  it('URL のフラグメントはタグではない', () => {
    expect(parseInlineTags('https://example.com/page#section を見る')).toEqual([])
  })

  it('数字だけはタグではない', () => {
    expect(parseInlineTags('#1 と #2026 と #v2').map((t) => t.tag)).toEqual(['v2'])
  })

  it('コードの中は拾わない', () => {
    expect(parseInlineTags('`#コード` と #本物\n\n```\n#フェンス\n```\n').map((t) => t.tag))
      .toEqual(['本物'])
  })

  it('句読点でタグが切れ、句読点の直後のタグも拾う (日本語の書き方)', () => {
    expect(parseInlineTags('#仕事、#読書。#メモ').map((t) => t.tag)).toEqual(['仕事', '読書', 'メモ'])
    expect(parseInlineTags('(#括弧) [#角括弧]').map((t) => t.tag)).toEqual(['括弧', '角括弧'])
  })

  it('行番号と位置を返す', () => {
    const [ref] = parseInlineTags('1 行目\n2 行目 #タグ')
    expect(ref).toMatchObject({ tag: 'タグ', line: 2 })
    expect('1 行目\n2 行目 #タグ'.slice(ref?.start, ref?.end)).toBe('#タグ')
  })
})

describe('frontmatterTags', () => {
  it('インラインの配列', () => {
    expect(frontmatterTags('---\ntags: [仕事, 読書]\n---\n')).toEqual(['仕事', '読書'])
  })

  it('カンマ区切り', () => {
    expect(frontmatterTags('---\ntags: 仕事, 読書\n---\n')).toEqual(['仕事', '読書'])
  })

  it('ブロックシーケンス', () => {
    expect(frontmatterTags('---\ntags:\n  - 仕事\n  - "読書"\n---\n')).toEqual(['仕事', '読書'])
  })

  it('# が付いていても落とす', () => {
    expect(frontmatterTags('---\ntags: [#仕事]\n---\n')).toEqual(['仕事'])
  })

  it('frontmatter が無ければ空', () => {
    expect(frontmatterTags(null)).toEqual([])
  })
})

describe('collectTags', () => {
  it('frontmatter と本文を合わせて重複を畳む', () => {
    const note = '---\ntags: [仕事]\n---\n\n#仕事 と #読書\n'
    expect(collectTags(note)).toEqual(['仕事', '読書'])
  })

  it('大小文字違いは同じタグ (最初の表記を残す)', () => {
    expect(collectTags('#Work と #work')).toEqual(['Work'])
  })
})

describe('countTags', () => {
  it('多い順 → 名前順', () => {
    expect(countTags([
      { path: 'a.md', content: '#仕事 #読書' },
      { path: 'b.md', content: '#仕事' },
      { path: 'c.md', content: '#趣味' },
    ])).toEqual([
      { tag: '仕事', count: 2 },
      { tag: '趣味', count: 1 },
      { tag: '読書', count: 1 },
    ])
  })

  it('1 ノートに同じタグが 2 回あっても 1 件', () => {
    expect(countTags([{ path: 'a.md', content: '#仕事 #仕事' }])).toEqual([{ tag: '仕事', count: 1 }])
  })
})

describe('noteHasTag', () => {
  it('親タグは子タグにも一致する', () => {
    expect(noteHasTag('#読書/SF', '読書')).toBe(true)
    expect(noteHasTag('#読書/SF', '読書/SF')).toBe(true)
    expect(noteHasTag('#読書', '読書/SF')).toBe(false)
  })

  it('# を付けて渡してもよい', () => {
    expect(noteHasTag('#仕事', '#仕事')).toBe(true)
  })
})
