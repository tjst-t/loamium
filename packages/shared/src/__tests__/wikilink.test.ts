import { describe, it, expect } from 'vitest'
import {
  findBacklinksIn, maskCode, parseWikiLinks, preferredWikiTarget, resolveWikiLink, rewriteWikiLinks,
} from '../wikilink'

describe('parseWikiLinks', () => {
  it('素のリンク', () => {
    const [link] = parseWikiLinks('前 [[ノート]] 後')
    expect(link).toMatchObject({ target: 'ノート', heading: null, alias: null, raw: '[[ノート]]' })
  })

  it('見出しと表示名', () => {
    expect(parseWikiLinks('[[note#見出し]]')[0]).toMatchObject({ target: 'note', heading: '見出し' })
    expect(parseWikiLinks('[[note|別名]]')[0]).toMatchObject({ target: 'note', alias: '別名' })
    expect(parseWikiLinks('[[note#見出し|別名]]')[0]).toMatchObject({
      target: 'note', heading: '見出し', alias: '別名',
    })
  })

  it('フォルダ付きのパス', () => {
    expect(parseWikiLinks('[[日誌/2026-08-22]]')[0]?.target).toBe('日誌/2026-08-22')
  })

  it('1 行に複数あっても全部拾う', () => {
    expect(parseWikiLinks('[[a]] と [[b]]').map((l) => l.target)).toEqual(['a', 'b'])
  })

  it('空のリンクは無視する', () => {
    expect(parseWikiLinks('[[]] [[ ]]')).toEqual([])
  })

  it('コードフェンスの中は拾わない (書き換えるとサンプルが壊れる)', () => {
    const text = '[[本物]]\n\n```md\n[[サンプル]]\n```\n\n[[本物2]]'
    expect(parseWikiLinks(text).map((l) => l.target)).toEqual(['本物', '本物2'])
  })

  it('インラインコードの中も拾わない', () => {
    expect(parseWikiLinks('`[[リテラル]]` と [[本物]]').map((l) => l.target)).toEqual(['本物'])
  })

  it('位置は元テキストの位置 (マスクでずれない)', () => {
    const text = '`[[x]]` [[本物]]'
    const [link] = parseWikiLinks(text)
    expect(text.slice(link?.start, link?.end)).toBe('[[本物]]')
  })
})

describe('maskCode', () => {
  it('長さを変えない (位置がずれるとリンクの範囲が壊れる)', () => {
    const text = 'a\n```\nb\n```\nc `d` e'
    expect(maskCode(text)).toHaveLength(text.length)
  })
})

const KNOWN = [
  'index.md',
  '日誌/2026-08-22.md',
  'プロジェクト/計画.md',
  'プロジェクト/メモ.md',
  'アーカイブ/メモ.md',
]

describe('resolveWikiLink', () => {
  it('ノート名だけで解決する', () => {
    expect(resolveWikiLink('計画', KNOWN)).toBe('プロジェクト/計画.md')
  })

  it('フォルダ付きのパスで解決する', () => {
    expect(resolveWikiLink('日誌/2026-08-22', KNOWN)).toBe('日誌/2026-08-22.md')
  })

  it('.md を付けても解決する', () => {
    expect(resolveWikiLink('index.md', KNOWN)).toBe('index.md')
  })

  it('大小文字と NFC のゆれを吸収する', () => {
    expect(resolveWikiLink('INDEX', KNOWN)).toBe('index.md')
    expect(resolveWikiLink('メモ'.normalize('NFD'), KNOWN, 'アーカイブ/x.md')).toBe('アーカイブ/メモ.md')
  })

  it('同名が複数あるときはリンク元と同じフォルダを優先する', () => {
    expect(resolveWikiLink('メモ', KNOWN, 'プロジェクト/計画.md')).toBe('プロジェクト/メモ.md')
    expect(resolveWikiLink('メモ', KNOWN, 'アーカイブ/古い.md')).toBe('アーカイブ/メモ.md')
  })

  it('同名が複数あってリンク元が無関係なら浅い階層 → 名前順', () => {
    expect(resolveWikiLink('メモ', KNOWN, 'index.md')).toBe('アーカイブ/メモ.md')
  })

  it('無ければ null (壊れリンク)', () => {
    expect(resolveWikiLink('存在しないノート', KNOWN)).toBeNull()
  })
})

describe('preferredWikiTarget', () => {
  it('ノート名が一意ならノート名だけ', () => {
    expect(preferredWikiTarget('プロジェクト/計画.md', KNOWN)).toBe('計画')
  })

  it('同名があるならフォルダ付き', () => {
    expect(preferredWikiTarget('プロジェクト/メモ.md', KNOWN)).toBe('プロジェクト/メモ')
  })
})

describe('rewriteWikiLinks', () => {
  it('リンク先だけ差し替え、見出しと表示名は保つ', () => {
    const text = '[[旧#見出し|表示名]] と [[別]]'
    const out = rewriteWikiLinks(text, (l) => (l.target === '旧' ? '新' : null))
    expect(out).toBe('[[新#見出し|表示名]] と [[別]]')
  })

  it('コードの中は書き換えない', () => {
    const text = '```\n[[旧]]\n```\n[[旧]]'
    expect(rewriteWikiLinks(text, () => '新')).toBe('```\n[[旧]]\n```\n[[新]]')
  })

  it('該当が無ければ元のまま', () => {
    const text = 'ただの本文'
    expect(rewriteWikiLinks(text, () => '新')).toBe(text)
  })
})

describe('findBacklinksIn', () => {
  it('書き方が違っても同じノートを指していれば拾う', () => {
    const content = '- [[計画]] を見る\n- [[プロジェクト/計画|別名]] も同じ\n- [[メモ]] は別'
    const hits = findBacklinksIn('index.md', content, 'プロジェクト/計画.md', KNOWN)
    expect(hits.map((h) => h.line)).toEqual([1, 2])
    expect(hits[0]).toMatchObject({ path: 'index.md', snippet: '- [[計画]] を見る' })
  })

  it('指していなければ空', () => {
    expect(findBacklinksIn('index.md', '[[メモ]]', 'プロジェクト/計画.md', KNOWN)).toEqual([])
  })
})
