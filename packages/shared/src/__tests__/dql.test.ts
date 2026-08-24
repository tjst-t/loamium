/**
 * dataview 風クエリ (task #20 / ADR-0001)。
 * ノートに残るのはフェンスだけ。ここは**読んで結果を作る**ところで、書き戻しはしない。
 */
import { describe, it, expect } from 'vitest'
import { parseQuery, runQuery, QueryError, type QueryNote } from '../dql'

const NOTES: QueryNote[] = [
  {
    path: 'データ/失敗の科学.md',
    mtime: '2026-08-01T00:00:00.000Z',
    content: '---\ntitle: 失敗の科学\nstatus: 読了\nrating: 5\ntags: [book, 読書]\n---\n\n- [x] 読む\n- [ ] 感想を書く [due:: 2026-09-01]\n',
  },
  {
    path: 'データ/SF短編集.md',
    mtime: '2026-08-20T00:00:00.000Z',
    content: '---\ntitle: SF 短編集\nstatus: 読書中\nrating: 3\ntags: [book]\n---\n\n- [ ] 3 章まで [priority:: high]\n',
  },
  {
    path: 'プロジェクト/Hydra.md',
    mtime: '2026-08-10T00:00:00.000Z',
    content: '---\nstatus: 進行中\npriority: 2\n---\n\n#project の本文\n\n- [ ] 設計する\n',
  },
]

const run = (source: string) => runQuery(parseQuery(source), NOTES)
const paths = (source: string): string[] => run(source).rows.map((r) => r.path)

describe('クエリを読む', () => {
  it('種類・列・FROM・WHERE・SORT・LIMIT を切り分ける', () => {
    const query = parseQuery('TABLE status, rating AS "点数" FROM #book WHERE rating >= 3 SORT rating DESC LIMIT 5')
    expect(query.kind).toBe('TABLE')
    expect(query.columns).toEqual([
      { field: 'status', label: 'status' },
      { field: 'rating', label: '点数' },
    ])
    expect(query.from).toEqual([{ kind: 'tag', value: 'book' }])
    expect(query.where).toEqual([{ field: 'rating', op: '>=', value: 3 }])
    expect(query.sort).toEqual([{ field: 'rating', desc: true }])
    expect(query.limit).toBe(5)
  })

  it('大文字小文字と改行を問わない', () => {
    const query = parseQuery('list\nfrom "データ"\nsort file.name asc')
    expect(query.kind).toBe('LIST')
    expect(query.from).toEqual([{ kind: 'folder', value: 'データ' }])
    expect(query.sort).toEqual([{ field: 'file.name', desc: false }])
  })

  it('書き方が違えば理由を言って落ちる (黙って空にしない)', () => {
    expect(() => parseQuery('SELECT * FROM notes')).toThrow(QueryError)
    expect(() => parseQuery('TABLE FROM #book')).toThrow(/列が要ります/)
  })
})

describe('LIST', () => {
  it('タグで絞る (子タグも含む)', () => {
    expect(paths('LIST FROM #book').sort()).toEqual(['データ/SF短編集.md', 'データ/失敗の科学.md'])
  })

  it('フォルダで絞る', () => {
    expect(paths('LIST FROM "データ"').sort()).toEqual(['データ/SF短編集.md', 'データ/失敗の科学.md'])
  })

  it('frontmatter で絞る', () => {
    expect(paths('LIST WHERE status = "読了"')).toEqual(['データ/失敗の科学.md'])
    expect(paths('LIST WHERE rating > 3')).toEqual(['データ/失敗の科学.md'])
    expect(paths('LIST WHERE tags contains "book"').sort())
      .toEqual(['データ/SF短編集.md', 'データ/失敗の科学.md'])
  })

  it('値を書かなければ「持っているか」で絞る', () => {
    expect(paths('LIST WHERE rating').sort()).toEqual(['データ/SF短編集.md', 'データ/失敗の科学.md'])
    expect(paths('LIST WHERE !rating')).toEqual(['プロジェクト/Hydra.md'])
  })

  it('SORT と LIMIT', () => {
    expect(paths('LIST FROM "データ" SORT file.name ASC'))
      .toEqual(['データ/SF短編集.md', 'データ/失敗の科学.md'])
    expect(paths('LIST SORT file.mtime DESC LIMIT 1')).toEqual(['データ/SF短編集.md'])
  })

  it('表示名は frontmatter の title を優先する', () => {
    expect(run('LIST FROM #book SORT file.name ASC').rows.map((r) => r.title))
      .toEqual(['SF 短編集', '失敗の科学'])
  })
})

describe('TABLE', () => {
  it('列の順に値を返す', () => {
    const result = run('TABLE status, rating FROM #book SORT rating DESC')
    expect(result.columns).toEqual(['status', 'rating'])
    expect(result.rows.map((r) => r.values)).toEqual([['読了', 5], ['読書中', 3]])
  })

  it('file.* の組み込みも列にできる', () => {
    expect(run('TABLE file.folder FROM #book LIMIT 1').rows[0]?.values).toEqual(['データ'])
  })
})

describe('TASK', () => {
  it('チェックボックスの行を横断で集める', () => {
    const result = run('TASK FROM "データ"')
    expect(result.rows.map((r) => r.task?.text)).toEqual(['読む', '感想を書く', '3 章まで'])
    expect(result.rows[0]?.task?.checked).toBe(true)
  })

  it('completed とインラインフィールドで絞れる', () => {
    expect(run('TASK WHERE !completed').rows).toHaveLength(3)
    expect(run('TASK WHERE priority = "high"').rows.map((r) => r.task?.text)).toEqual(['3 章まで'])
    expect(run('TASK WHERE due > "2026-08-01"').rows.map((r) => r.task?.text)).toEqual(['感想を書く'])
  })

  it('行番号を返す (押したときに元の行を書き換えるため)', () => {
    expect(run('TASK FROM "プロジェクト"').rows[0]?.task).toMatchObject({ line: 7, checked: false })
  })
})

describe('組み込みフィールド', () => {
  it('file.tasks / file.open_tasks でやり残しを引ける', () => {
    expect(run('TABLE file.tasks, file.open_tasks FROM "データ" SORT file.name ASC').rows.map((r) => r.values))
      .toEqual([[1, 1], [2, 1]])
    // 値を書かなければ「0 でないもの」= やり残しがあるノート
    expect(paths('LIST WHERE file.open_tasks').sort())
      .toEqual(['データ/SF短編集.md', 'データ/失敗の科学.md', 'プロジェクト/Hydra.md'])
  })
})
