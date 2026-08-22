import type { JSX } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { UiFeature } from '../feature'

export interface InfoPanelProps {
  open: boolean
  onToggle: () => void
  path: string | null
  content: string | null
  /** 有効な機能。パネルの節はここから生える */
  features: readonly UiFeature[]
}

export function InfoPanel({ open, onToggle, path, content, features }: InfoPanelProps): JSX.Element {
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
        <>
          <dl className="panel-facts">
            <dt>パス</dt>
            <dd>{path}</dd>
            <dt>文字数</dt>
            <dd>{content === null ? '—' : content.length.toLocaleString()}</dd>
            <dt>行数</dt>
            <dd>{lines === null ? '—' : lines.toLocaleString()}</dd>
          </dl>
          {features.map((feature) => (
            feature.panelSection === undefined
              ? null
              : <div key={feature.name}>{feature.panelSection({ path })}</div>
          ))}
        </>
      )}
    </aside>
  )
}
