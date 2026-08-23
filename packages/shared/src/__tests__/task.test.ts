/**
 * タスク (task #19 / ADR-0029)。
 * 肝は **1 行しか触らない**こと (他の行のバイトが動くと round-trip と 3-way merge が壊れる)。
 */
import { describe, it, expect } from 'vitest'
import { parseTasks, parseInlineFields, setTaskChecked, setTaskField } from '../task'

const NOTE = [
  '# やること',
  '',
  '- [ ] 資料を集める',
  '- [x] 下書きを書く',
  '  - [ ] 図をつくる [priority:: high]',
  '- [ ] レビュー [status:: progress] [due:: 2026-08-30]',
  '',
  '```md',
  '- [ ] これは説明なので数えない',
  '```',
  '',
].join('\n')

describe('タスクを読む', () => {
  it('チェックボックスの行だけを拾い、フィールドを分ける', () => {
    const tasks = parseTasks(NOTE)
    expect(tasks.map((t) => [t.line, t.checked, t.text])).toEqual([
      [2, false, '資料を集める'],
      [3, true, '下書きを書く'],
      [4, false, '図をつくる'],
      [5, false, 'レビュー'],
    ])
    expect(tasks[3]?.fields).toEqual({ status: 'progress', due: '2026-08-30' })
  })

  it('コードフェンスの中は数えない', () => {
    expect(parseTasks(NOTE).some((t) => t.text.includes('説明'))).toBe(false)
  })

  it('インラインフィールドは Dataview の書き方', () => {
    expect(parseInlineFields('やる [status:: progress] [x:: 1]').map((f) => [f.key, f.value]))
      .toEqual([['status', 'progress'], ['x', '1']])
    // `::` が無いものはただの文字列
    expect(parseInlineFields('[[WikiLink]] や [注釈]')).toEqual([])
  })
})

describe('タスクを書く', () => {
  it('チェックの入り切りはその行だけ変える', () => {
    const next = setTaskChecked(NOTE, 2, true)
    expect(next.split('\n')[2]).toBe('- [x] 資料を集める')
    expect(next.split('\n').filter((_, i) => i !== 2)).toEqual(NOTE.split('\n').filter((_, i) => i !== 2))
  })

  it('フィールドを足す・書き換える・消す', () => {
    expect(setTaskField(NOTE, 2, 'status', 'progress').split('\n')[2])
      .toBe('- [ ] 資料を集める [status:: progress]')
    expect(setTaskField(NOTE, 5, 'status', 'done').split('\n')[5])
      .toBe('- [ ] レビュー [status:: done] [due:: 2026-08-30]')
    expect(setTaskField(NOTE, 5, 'due', null).split('\n')[5])
      .toBe('- [ ] レビュー [status:: progress]')
  })

  it('消したあとに空白が溜まらない', () => {
    expect(setTaskField('- [ ] やる [status:: progress]', 0, 'status', null))
      .toBe('- [ ] やる')
  })

  it('入れ子のリストでもインデントを保つ', () => {
    expect(setTaskChecked(NOTE, 4, true).split('\n')[4]).toBe('  - [x] 図をつくる [priority:: high]')
  })
})
