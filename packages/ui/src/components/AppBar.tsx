import type { JSX } from 'react'
import { Menu, PanelRight, Search } from 'lucide-react'

export interface AppBarProps {
  /** いま開いているものの名前 (ノート名 / 画面名) */
  title: string
  onOpenNav: () => void
  onOpenInfo: () => void
  onSearch: () => void
  /** 情報の面を出せるか (ノートを開いていないときは出さない) */
  canOpenInfo: boolean
}

/**
 * モバイルの上部バー (定番の配置)。
 * 左 = ナビゲーションを開く / 中央 = いまどこにいるか / 右 = 検索と情報。
 * どのボタンも 44px。
 */
export function AppBar({ title, onOpenNav, onOpenInfo, onSearch, canOpenInfo }: AppBarProps): JSX.Element {
  return (
    <header className="appbar">
      <button type="button" className="appbar-button" onClick={onOpenNav} aria-label="ノートを開く">
        <Menu size={20} />
      </button>
      <span className="appbar-title">{title}</span>
      <button type="button" className="appbar-button" onClick={onSearch} aria-label="検索">
        <Search size={18} />
      </button>
      {canOpenInfo && (
        <button type="button" className="appbar-button" onClick={onOpenInfo} aria-label="このノートの情報">
          <PanelRight size={18} />
        </button>
      )}
    </header>
  )
}
