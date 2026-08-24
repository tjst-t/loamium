/**
 * UI 機能レジストリ (2 レジストリ方式) の契約を固定する。
 *
 * 「サーバーの登録行を消したら、UI もリロードで消える」が実際に成立しているか。
 */
import { describe, it, expect } from 'vitest'
import { editorPlugins, enabledFeatures, uiFeatures } from '../features'

describe('UI 機能レジストリ', () => {
  it('登録された機能は名前を持ち、名前が重複しない', () => {
    const names = uiFeatures.map((f) => f.name)
    expect(names.every((name) => name !== '')).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it('サーバー機能に対応するものは requires を書く (outline のようにエディタ内で完結するものは書かない)', () => {
    const requiring = uiFeatures.filter((f) => f.requires !== undefined).map((f) => f.name)
    expect(requiring).toEqual(['journal', 'bookmarks', 'notes', 'search', 'properties', 'links', 'tags', 'embed', 'files', 'tasks', 'dataview'])
    expect(uiFeatures.find((f) => f.name === 'outline')?.requires).toBeUndefined()
  })

  it('サイドバーの並び順は登録順 (ジャーナル → ツリー → 詳細検索)', () => {
    expect(uiFeatures.filter((f) => f.sidebarItem !== undefined).map((f) => f.name))
      .toEqual(['journal', 'bookmarks', 'notes', 'search'])
  })

  it('コマンドはシェルを受け取り、キーは Mod 表記で宣言される', () => {
    const keys = uiFeatures.flatMap((f) => f.commands?.({} as never) ?? []).map((c) => c.keys)
    expect(keys).toContain('Mod+k')
    expect(keys).toContain('Mod+Shift+f')
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
