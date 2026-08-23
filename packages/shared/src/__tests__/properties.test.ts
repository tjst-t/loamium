/**
 * frontmatter プロパティ (task #17)。
 * 一番大事なのは **触っていない行が原文のまま残る**こと (git sync と 3-way merge のため)。
 */
import { describe, it, expect } from 'vitest'
import { readProperties, applyPropertyEdit, inferType, countPropertyKeys } from '../properties'

const NOTE = [
  '---',
  '# 下書きのまま置いてある',
  'title: 走り書き',
  'created: 2026-08-23',
  'done: false',
  'count: 3',
  'tags:',
  '  - 仕事',
  '  - 読書',
  '---',
  '',
  '本文はそのまま。',
  '',
].join('\n')

describe('プロパティを読む', () => {
  it('型を当てて順番のまま返す', () => {
    expect(readProperties(NOTE)).toEqual([
      { key: 'title', type: 'text', value: '走り書き' },
      { key: 'created', type: 'date', value: '2026-08-23' },
      { key: 'done', type: 'boolean', value: false },
      { key: 'count', type: 'number', value: 3 },
      { key: 'tags', type: 'tags', value: ['仕事', '読書'] },
    ])
  })

  it('frontmatter が無ければ空', () => {
    expect(readProperties('# 見出し\n')).toEqual([])
  })

  it('tags はキー名で決まる (カンマ区切りも受ける)', () => {
    expect(inferType('tags', '仕事, 読書')).toBe('tags')
    expect(readProperties('---\ntags: 仕事, 読書\n---\n本文\n')[0]?.value).toEqual(['仕事', '読書'])
  })
})

describe('プロパティを書く', () => {
  it('触っていない行とコメントを原文のまま残す', () => {
    const next = applyPropertyEdit(NOTE, { key: 'title', value: { type: 'text', value: '清書' } })
    expect(next).toContain('# 下書きのまま置いてある')
    expect(next).toContain('title: 清書')
    expect(next).toContain('  - 読書')
    expect(next.endsWith('\n本文はそのまま。\n')).toBe(true)
  })

  it('キーを消す / 全部消えたら --- ごと消える', () => {
    expect(applyPropertyEdit(NOTE, { key: 'count', remove: true })).not.toContain('count')
    expect(applyPropertyEdit('---\nonly: 1\n---\n本文\n', { key: 'only', remove: true })).toBe('本文\n')
  })

  it('frontmatter が無いノートには作る', () => {
    expect(applyPropertyEdit('本文\n', { key: 'title', value: { type: 'text', value: 'あ' } }))
      .toBe('---\ntitle: あ\n---\n本文\n')
  })

  it('キー名を変えても並びが変わらない', () => {
    const next = applyPropertyEdit(NOTE, { key: 'count', renameTo: 'ページ数' })
    const keys = readProperties(next).map((p) => p.key)
    expect(keys).toEqual(['title', 'created', 'done', 'ページ数', 'tags'])
  })

  it('型どおりに書く (文字列の "3" を数値にできる)', () => {
    const next = applyPropertyEdit('本文\n', { key: 'n', value: { type: 'number', value: '3' } })
    expect(next).toBe('---\nn: 3\n---\n本文\n')
    expect(applyPropertyEdit('本文\n', { key: 'ok', value: { type: 'boolean', value: true } }))
      .toBe('---\nok: true\n---\n本文\n')
    expect(applyPropertyEdit('本文\n', { key: 'tags', value: { type: 'tags', value: ['a', 'b'] } }))
      .toBe('---\ntags:\n  - a\n  - b\n---\n本文\n')
  })
})

describe('vault のキー', () => {
  it('使われている数の多い順に返す', () => {
    expect(countPropertyKeys([{ content: NOTE }, { content: '---\ntitle: b\n---\n' }])).toEqual([
      { key: 'title', type: 'text', count: 2 },
      { key: 'count', type: 'number', count: 1 },
      { key: 'created', type: 'date', count: 1 },
      { key: 'done', type: 'boolean', count: 1 },
      { key: 'tags', type: 'tags', count: 1 },
    ])
  })
})
