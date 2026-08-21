/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { defineFeature, FeatureContractError } from '../feature'

describe('defineFeature: 機能とエージェントツールの乖離を構造で防ぐ', () => {
  it('REST ルートがあるのにツールが無ければ登録時点で落ちる', () => {
    expect(() =>
      defineFeature({ name: 'x', routes: () => {}, help: [{ name: 'x', body: '' }] }),
    ).toThrow(FeatureContractError)
  })

  it('REST ルートがあるのに help が無ければ登録時点で落ちる', () => {
    expect(() =>
      defineFeature({
        name: 'x',
        routes: () => {},
        tools: [{ name: 't', description: '', capability: 'read', run: () => Promise.resolve(null) }],
      }),
    ).toThrow(FeatureContractError)
  })

  it('3 点そろっていれば通る', () => {
    expect(() =>
      defineFeature({
        name: 'x',
        routes: () => {},
        tools: [{ name: 't', description: '', capability: 'read', run: () => Promise.resolve(null) }],
        help: [{ name: 'x', body: '# x' }],
      }),
    ).not.toThrow()
  })

  it('ルートを持たない機能はツール無しでもよい', () => {
    expect(() => defineFeature({ name: 'x' })).not.toThrow()
  })

  it('http と tools が inject に自動で入る', () => {
    const p = defineFeature({ name: 'x', inject: ['vault'] }) as unknown as { inject: string[] }
    expect(p.inject).toEqual(['http', 'tools', 'vault'])
  })
})
