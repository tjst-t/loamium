/**
 * `==ハイライト==` が原文のまま保存されること (task #13)。
 *
 * 行頭の `=` は setext 見出しの下線に化けうるので remark が `\=` に逃がす。
 * そのままだと Obsidian でハイライトとして読めなくなるため、**対になっている `==` のときだけ**
 * 復元する。⚠️ エスケープを一律で切ると表の `\|` まで剥がれて列が壊れる (既知の事故)。
 */
import { describe, it, expect } from 'vitest'
import { normalizeForSave, roundTrip } from '../index'

describe('ハイライトのエスケープ', () => {
  it('行頭の ==…== に backslash を付けない', () => {
    expect(normalizeForSave('==強調したい==\n')).toBe('==強調したい==\n')
  })

  it('文中の ==…== はそのまま', () => {
    expect(normalizeForSave('これは ==大事== です\n')).toBe('これは ==大事== です\n')
  })

  it('リストや引用の中でも保つ', () => {
    expect(normalizeForSave('- ==大事==\n')).toBe('- ==大事==\n')
    expect(normalizeForSave('> ==大事==\n')).toBe('> ==大事==\n')
  })

  it('冪等 (二度目以降は動かない)', () => {
    const once = normalizeForSave('==強調==\nこれは ==大事== です\n')
    expect(roundTrip(once)).toBe(once)
  })

  it('単独の = には触れない (setext 見出しに化けさせない)', () => {
    // `=` 1 つだけの行は見出しの下線になりうるので、エスケープを残す
    expect(normalizeForSave('a\n\n\\= b\n')).toContain('\\=')
  })

  it('表の `\\|` は剥がさない (2 列の表が 4 列に化けた事故の再発防止)', () => {
    const table = '| a | b |\n| - | - |\n| x \\| y | z |\n'
    expect(normalizeForSave(table)).toBe(table)
  })
})
