import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { X } from 'lucide-react'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  /** 出てくる向き。左 = ナビゲーション、右 = いま開いているものの情報 */
  side: 'left' | 'right'
  title: string
  children: ReactNode
}

/**
 * 画面の横から出てくる面 (モバイルの定番)。
 *
 * 守っていること:
 * - 背後の画面はスクロールしない (`body.is-drawer-open`)
 * - 背景 (scrim) のタップと Escape で閉じる
 * - 開いたらフォーカスを中へ移し、閉じたら元へ戻す
 * - `aria-modal` + `role="dialog"`。閉じるボタンは 44px
 */
export function Drawer({ open, onClose, side, title, children }: DrawerProps): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.classList.add('is-drawer-open')
    panel.current?.focus()

    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('is-drawer-open')
      restoreTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer-scrim" onPointerDown={onClose}>
      <div
        className={`drawer drawer-${side}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onPointerDown={(event) => { event.stopPropagation() }}
      >
        <div className="drawer-head">
          <span className="drawer-title">{title}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="閉じる">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  )
}
