import { describe, it, expect } from 'vitest'
import { pathFromSearch, searchForPath } from '../route'

describe('pathFromSearch', () => {
  it('?path= から vault パスを取り出す', () => {
    expect(pathFromSearch('?path=journals/2026-08-22.md')).toBe('journals/2026-08-22.md')
  })

  it('日本語パス (URL エンコード) を戻す', () => {
    expect(pathFromSearch('?path=%E6%97%A5%E8%AA%8C%2F%E3%83%A1%E3%83%A2.md')).toBe('日誌/メモ.md')
  })

  it('path が無ければ null', () => {
    expect(pathFromSearch('')).toBeNull()
    expect(pathFromSearch('?q=hello')).toBeNull()
  })

  it('空文字や空白だけなら null', () => {
    expect(pathFromSearch('?path=')).toBeNull()
    expect(pathFromSearch('?path=%20%20')).toBeNull()
  })

  it('先頭の / は落とす (vault パスは常に相対)', () => {
    expect(pathFromSearch('?path=/index.md')).toBe('index.md')
  })
})

describe('searchForPath', () => {
  it('往復する', () => {
    for (const path of ['index.md', '日誌/メモ.md', 'a b/c&d.md', 'プロジェクト/計画 (案).md']) {
      expect(pathFromSearch(searchForPath(path))).toBe(path)
    }
  })

  it('null なら空 (ルート)', () => {
    expect(searchForPath(null)).toBe('')
  })
})
