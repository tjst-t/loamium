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
  /**
   * 開いているノートに対する操作。エディタの上のバー (保存の左) に並ぶ。
   * ★ のように「いま見ているノート 1 枚」に効くものだけを置くこと。
   */
  noteAction?: (props: { path: string }) => JSX.Element | null
  /** 左サイドバーに足す区画 (並び順は features.ts の登録順) */
  sidebarItem?: () => JSX.Element | null
  /** 画面全体に重ねるもの (コマンドパレットなど)。開閉は機能側が持つ */
  overlay?: () => JSX.Element | null
  /** URL に応じてメイン領域を占める画面 (検索ページなど) */
  view?: {
    match: (route: { path: string | null; search: SearchParams | null }) => boolean
    render: () => JSX.Element
  }
  /**
   * コマンド。`keys` を書けばシェルがキーバインドとして張る (task #28 の統合パレットもここから引く)。
   * 表記は `Mod+k` / `Mod+Shift+f` (`Mod` = Ctrl / macOS では Cmd)。
   */
  commands?: (shell: Shell) => UiCommand[]
}

export interface UiCommand {
  id: string
  title: string
  /** 例: `Mod+k` / `Mod+Shift+f`。省略するとキーバインドは張られない */
  keys?: string
  run: () => void
}

/** `Mod+Shift+f` のような表記とキーイベントを突き合わせる */
export function matchesKeys(keys: string, event: KeyboardEvent): boolean {
  const parts = keys.toLowerCase().split('+')
  const key = parts.at(-1) ?? ''
  const want = {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  }
  return event.key.toLowerCase() === key
    && want.mod === (event.metaKey || event.ctrlKey)
    && want.shift === event.shiftKey
    && want.alt === event.altKey
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
  /** 開いているノートの中身 (frontmatter を含む)。開いていなければ null */
  content: string | null
  /**
   * 開いているノートの中身を差し替える (frontmatter の書き換えなど、**本文の外**から触るとき)。
   * ファイルへの書き込みは機能が自分で済ませてから呼ぶこと — ここは画面を合わせるだけ。
   */
  patchContent: (next: string) => void
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
  /**
   * 重なっている面 (モバイルのドロワー) を閉じる。デスクトップでは何も起きない。
   * **画面遷移や本文内ジャンプを起こした機能は、これを呼ぶ。**
   * どこに置かれているかを機能が知らなくても、モバイルで正しく畳める。
   */
  dismiss: () => void
  /** その日のジャーナルを開く (省略時は今日) */
  openJournal: (date?: string) => void
  /** ノート / フォルダを作る */
  createEntry: (parent: string, name: string, kind: 'folder' | 'note') => void
  /** リネーム・移動 (本文中の [[リンク]] はサーバー側で追従する) */
  renameEntry: (from: string, to: string) => void
  /** 削除 (フォルダは中身ごと) */
  deleteEntry: (node: TreeNode) => void
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
