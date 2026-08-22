import { createContext, useContext, type JSX, type ReactNode } from 'react'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { TreeNode } from './api'
import type { SearchParams } from './route'

/**
 * UI 側の 1 機能 = 1 プラグイン (task: UI プラガブル化)。
 *
 * サーバーの `defineFeature` と対になる。実体は
 * `packages/features/<機能名>/ui.tsx` に置き、`packages/ui/src/features.ts` が静的に登録する。
 * **登録行を消せば機能が丸ごと消える**のがこの仕組みの目的。
 *
 * ⚠️ **動的 import は使わない** (CLAUDE.md)。着脱は「登録行を消す」か、
 * サーバー側の機能の有無 (`requires`) による。反映はリロードで足りる。
 */
export interface UiFeature {
  name: string
  /**
   * このサーバー機能が登録されていなければ、UI 側も丸ごと無効になる。
   * `app.ts` から `ctx.plugin(tagsFeature)` を消すと、リロードでタグの UI が消える。
   */
  requires?: string
  /**
   * Milkdown プラグイン。
   * ⚠️ **順序が意味を持つ。** `[[` や `#` の補完は Enter / Tab をリストのコマンドより
   * 先に拾う必要があるので `before-preset`。順序をコメントではなく型で持たせる。
   */
  editor?: { order: 'before-preset' | 'after-preset'; plugins: MilkdownPlugin[] }
  /** 情報パネルに足す節 */
  panelSection?: (props: { path: string }) => JSX.Element | null
  /** 左サイドバーに足す入口 */
  sidebarItem?: () => JSX.Element | null
  /** URL に応じてメイン領域を占める画面 (検索ページなど) */
  view?: {
    match: (route: { path: string | null; search: SearchParams | null }) => boolean
    render: () => JSX.Element
  }
  /** キーボードショートカット。パレット (task #28) もここから引く想定 */
  commands?: { id: string; title: string; keys?: string; run: () => void }[]
}

export function defineUiFeature(feature: UiFeature): UiFeature {
  return feature
}

/**
 * シェルが機能へ渡すもの。**機能どうしは直接つながらない**ので、
 * 機能を外しても他が壊れない (props のバケツリレーもここで止まる)。
 */
export interface Shell {
  notes: readonly string[]
  tags: readonly string[]
  tree: TreeNode[]
  currentPath: string | null
  search: SearchParams | null
  /** ノートを開く */
  openNote: (path: string) => void
  /** 検索結果を開いて該当箇所へ */
  openHit: (path: string, needle: string) => void
  /** タグで絞った検索ページへ */
  openTag: (tag: string) => void
  /** 空の検索ページへ */
  openSearch: () => void
  /** 検索条件を変える */
  setSearch: (next: Partial<SearchParams>) => void
}

const ShellContext = createContext<Shell | null>(null)

export function ShellProvider({ value, children }: { value: Shell; children: ReactNode }): JSX.Element {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell(): Shell {
  const shell = useContext(ShellContext)
  if (shell === null) throw new Error('ShellProvider の外で useShell を呼んでいる')
  return shell
}
