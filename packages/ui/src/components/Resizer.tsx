import { useCallback, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'

export interface ResizerProps {
  /** どちら側のペインを掴んでいるか。右ペインはドラッグ方向と幅の増減が逆になる */
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  /** 既定値。ダブルクリックで戻す */
  reset: number
  onChange: (width: number) => void
  /** ドラッグが終わったとき (保存はここで 1 回だけ) */
  onCommit: (width: number) => void
  label: string
}

const STEP = 16

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/**
 * ペインの幅を掴んで変えるつまみ。
 *
 * `role="separator"` + 矢印キーに対応する (マウスでしか動かせない UI にしない)。
 * ドラッグ中は pointer capture を使うので、速く動かしてカーソルが外れても追従する。
 */
export function Resizer({ side, width, min, max, reset, onChange, onCommit, label }: ResizerProps): JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, width }
    document.body.classList.add('is-resizing')
  }, [width])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (start === null) return
    const delta = event.clientX - start.x
    onChange(clamp(start.width + (side === 'left' ? delta : -delta), min, max))
  }, [max, min, onChange, side])

  const stop = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return
    drag.current = null
    document.body.classList.remove('is-resizing')
    event.currentTarget.releasePointerCapture(event.pointerId)
    onCommit(width)
  }, [onCommit, width])

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => { onChange(reset); onCommit(reset) }}
      onKeyDown={(event) => {
        const towards = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
        if (towards === 0) return
        event.preventDefault()
        const next = clamp(width + towards * STEP * (side === 'left' ? 1 : -1), min, max)
        onChange(next)
        onCommit(next)
      }}
    />
  )
}
