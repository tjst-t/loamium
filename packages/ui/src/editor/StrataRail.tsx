import { useEffect, useState, type JSX } from 'react'

/**
 * 地層レール — 文書の断面図 (このアプリの署名)。
 *
 * 見出しごとに目盛りを立て、いまどの層を掘っているかを示す。目盛りの太さは見出しの階層、
 * 高さはその節の分量。クリックでその節へ飛ぶ。
 *
 * 本文の DOM から読むだけで、ファイルにもドキュメントにも一切書き込まない。
 */
interface Tick {
  id: number
  level: number
  /** 文書全体のどこにあるか (0–1)。レール上の位置になる */
  at: number
  top: number
  el: HTMLElement
}

const HEADING_SELECTOR = 'h1, h2, h3'

export function StrataRail({ scope }: { scope: HTMLElement | null }): JSX.Element | null {
  const [ticks, setTicks] = useState<Tick[]>([])
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (scope === null) return undefined
    const read = (): void => {
      const headings = [...scope.querySelectorAll<HTMLElement>(HEADING_SELECTOR)]
      const total = scope.scrollHeight || 1
      setTicks(headings.map((el, i) => ({
        id: i,
        level: Number(el.tagName.slice(1)),
        at: el.offsetTop / total,
        top: el.offsetTop,
        el,
      })))
    }
    read()
    // 本文は編集で伸び縮みする。監視して目盛りを引き直す
    const observer = new MutationObserver(read)
    observer.observe(scope, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect() }
  }, [scope])

  useEffect(() => {
    if (ticks.length === 0) return undefined
    const scroller = ticks[0]?.el.closest('.main')
    if (!(scroller instanceof HTMLElement)) return undefined
    const onScroll = (): void => {
      // いま画面上端に最も近い (それより上にある) 見出しが現在地
      const line = scroller.scrollTop + 80
      let at = 0
      for (const [i, tick] of ticks.entries()) if (tick.top <= line) at = i
      setCurrent(at)
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => { scroller.removeEventListener('scroll', onScroll) }
  }, [ticks])

  if (ticks.length < 2) return null // 目盛りが 1 本だけのレールは情報を持たない

  return (
    <div className="strata-col">
      <nav className="strata-rail" aria-label="この文書の見出し">
        {ticks.map((tick, i) => (
          <button
            key={tick.id}
            type="button"
            className={`strata-tick${i === current ? ' is-current' : ''} level-${String(Math.min(tick.level, 3))}`}
            style={{ top: `${String(Math.min(tick.at, 0.98) * 100)}%` }}
            title={tick.el.textContent ?? ''}
            aria-label={tick.el.textContent ?? '見出し'}
            onClick={() => { tick.el.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}
          />
        ))}
      </nav>
    </div>
  )
}
