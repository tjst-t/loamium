import { describe, it, expect } from 'vitest'
import { extractSection, listSections } from '../section'

const DOC = `# タイトル

前置き。

## 目的

3-2-1 バックアップ。

### 補足

細かい話。

## タスク

- [ ] やること
`

describe('listSections', () => {
  it('見出しを階層つきで並べる', () => {
    expect(listSections(DOC)).toEqual([
      { heading: 'タイトル', level: 1 },
      { heading: '目的', level: 2 },
      { heading: '補足', level: 3 },
      { heading: 'タスク', level: 2 },
    ])
  })

  it('コードフェンスの中の # は見出しにしない', () => {
    expect(listSections('```\n# これはコード\n```\n\n# 本物\n')).toEqual([{ heading: '本物', level: 1 }])
  })
})

describe('extractSection', () => {
  it('次の同じか上位の見出しまでを返す (下位の見出しは含む)', () => {
    expect(extractSection(DOC, '目的')?.body).toBe('3-2-1 バックアップ。\n\n### 補足\n\n細かい話。')
  })

  it('最後の節はファイル末尾まで', () => {
    expect(extractSection(DOC, 'タスク')?.body).toBe('- [ ] やること')
  })

  it('大小文字と NFC のゆれを吸収する', () => {
    expect(extractSection('## Goal\n\nx\n', 'goal')?.body).toBe('x')
  })

  it('無ければ null', () => {
    expect(extractSection(DOC, '存在しない')).toBeNull()
  })
})
