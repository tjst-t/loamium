/**
 * UI 機能レジストリ (2 レジストリ方式) の契約を固定する。
 *
 * 「サーバーの登録行を消したら、UI もリロードで消える」が実際に成立しているか。
 */
import { describe, it, expect } from 'vitest'
import { editorPlugins, enabledFeatures, uiFeatures } from '../features'

describe('UI 機能レジストリ', () => {
  it('登録された機能はすべて名前と requires を持つ', () => {
    for (const feature of uiFeatures) {
      expect(feature.name).not.toBe('')
      // requires が無い機能はサーバー側の状態に関係なく常に有効 (今は全部が対応を持つ)
      expect(typeof feature.requires).toBe('string')
    }
  })

  it('サーバーに無い機能は無効になる (リロードで反映される部分)', () => {
    const withoutTags = enabledFeatures(['notes', 'search', 'links'])
    expect(withoutTags.map((f) => f.name)).not.toContain('tags')
    expect(withoutTags.map((f) => f.name)).toContain('links')
  })

  it('サーバー機能をまだ取得していないときは止めない', () => {
    expect(enabledFeatures(null)).toEqual(uiFeatures)
  })

  it('機能を外すとその Milkdown プラグインも消える', () => {
    const all = editorPlugins(uiFeatures, 'before-preset')
    const withoutTags = editorPlugins(enabledFeatures(['links']), 'before-preset')
    expect(all.length).toBeGreaterThan(withoutTags.length)
  })

  it('エディタプラグインの順序は型で持つ (コメントで守らない)', () => {
    for (const feature of uiFeatures) {
      if (feature.editor === undefined) continue
      expect(['before-preset', 'after-preset']).toContain(feature.editor.order)
    }
  })
})
