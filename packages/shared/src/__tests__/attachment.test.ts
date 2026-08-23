/** 添付の判定 (task #16)。**ノートと添付の境目**を固定する (二重描画の元になるため) */
import { describe, it, expect } from 'vitest'
import { attachmentKind, attachmentName, contentTypeOf, isAttachment, isTextual, parseDelimited } from '../attachment'

describe('添付かどうか', () => {
  it('拡張子が無いもの・.md はノート', () => {
    expect(isAttachment('ノート')).toBe(false)
    expect(isAttachment('機能ガイド/テーブル')).toBe(false)
    expect(isAttachment('ノート.md')).toBe(false)
    expect(isAttachment('ノート#見出し')).toBe(false)
  })

  it('拡張子があれば添付', () => {
    expect(isAttachment('assets/図.png')).toBe(true)
    expect(isAttachment('資料.PDF')).toBe(true)
  })

  it('種類と Content-Type', () => {
    expect(attachmentKind('a.png')).toBe('image')
    expect(attachmentKind('a.pdf')).toBe('pdf')
    expect(attachmentKind('a.csv')).toBe('csv')
    expect(attachmentKind('a.ts')).toBe('code')
    expect(attachmentKind('a.bin')).toBe('other')
    expect(contentTypeOf('a.png')).toBe('image/png')
    // 分からないものはブラウザに解釈させない
    expect(contentTypeOf('a.bin')).toBe('application/octet-stream')
    expect(isTextual('a.csv')).toBe(true)
    expect(isTextual('a.png')).toBe(false)
  })
})

describe('保存する名前', () => {
  it('危険な文字を落とし、空白は - にする', () => {
    expect(attachmentName('スクリーン ショット.png', [])).toBe('スクリーン-ショット.png')
    // 先頭のドットは落とす (隠しファイルや `..` をそのまま名前にしない)
    expect(attachmentName('../etc/passwd', [])).toBe('-etc-passwd')
  })

  it('ぶつかったら連番 (黙って上書きしない)', () => {
    expect(attachmentName('図.png', ['図.png'])).toBe('図-2.png')
    expect(attachmentName('図.png', ['図.png', '図-2.png'])).toBe('図-3.png')
  })
})

describe('CSV', () => {
  it('引用符つきのセルを 1 つとして読む', () => {
    expect(parseDelimited('a,b\n"1,2",3\n')).toEqual([['a', 'b'], ['1,2', '3']])
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('画像の大きさ (Obsidian と同じ `|幅`)', () => {
  it('WikiLink の表示名の枠をそのまま使う (独自記法ではない)', async () => {
    const { parseWikiLinks } = await import('../wikilink')
    const [link] = parseWikiLinks('![[assets/図.png|420]]')
    expect(link).toMatchObject({ target: 'assets/図.png', alias: '420', embed: true })
    expect(isAttachment(link?.target ?? '')).toBe(true)
  })

  it('保存の正規化で消えない', async () => {
    const { normalizeForSave } = await import('../markdown/index')
    expect(normalizeForSave('![[assets/図.png|420]]\n')).toBe('![[assets/図.png|420]]\n')
  })
})
