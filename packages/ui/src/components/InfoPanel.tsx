import type { JSX } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'

export interface InfoPanelProps {
  open: boolean
  onToggle: () => void
  path: string | null
  content: string | null
}

/**
 * 右サイドバー (task #2 の「開閉」まで)。
 *
 * 中身は今のところ開いているノートの素の事実だけ。
 * バックリンク (task #6) や詳細な情報 (task #35) はここへ足していく。
 */
export function InfoPanel({ open, onToggle, path, content }: InfoPanelProps): JSX.Element {
  if (!open) {
    return (
      <aside className="panel-rail">
        <button type="button" className="icon-button" onClick={onToggle} aria-label="情報パネルを開く" title="情報パネルを開く">
          <PanelRightOpen size={18} />
        </button>
      </aside>
    )
  }

  const lines = content === null ? null : content.split('\n').length
  return (
    <aside className="panel">
      <div className="panel-header">
        <span className="panel-title">情報</span>
        <button type="button" className="icon-button" onClick={onToggle} aria-label="情報パネルを閉じる" title="情報パネルを閉じる">
          <PanelRightClose size={18} />
        </button>
      </div>
      {path === null ? (
        <p className="empty">ノートを選んでください</p>
      ) : (
        <dl className="panel-facts">
          <dt>パス</dt>
          <dd>{path}</dd>
          <dt>文字数</dt>
          <dd>{content === null ? '—' : content.length.toLocaleString()}</dd>
          <dt>行数</dt>
          <dd>{lines === null ? '—' : lines.toLocaleString()}</dd>
        </dl>
      )}
    </aside>
  )
}
