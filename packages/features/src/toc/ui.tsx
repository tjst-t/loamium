import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { List } from 'lucide-react'
import { defineUiFeature } from '@loamium/ui/src/feature'
import { headingFold, foldedHeadings, sectionsOf, toggleHeadingFoldAt, type Section } from './heading-fold'
import { activeEditorView, subscribe } from './toc-store'

/** いま開いている本文の見出し。折りたたみで隠れているものは出さない (画面と一致させる) */
function useSections(): Section[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      const view = activeEditorView()
      if (view === null) return EMPTY
      const sections = sectionsOf(view.state, foldedHeadings(view.state)).filter((s) => !s.hidden)
      // 同じ内容なら同じ配列を返す (useSyncExternalStore は参照で比較する)
      const key = sections.map((s) => `${String(s.pos)}:${String(s.level)}:${s.text}:${String(s.folded)}`).join('|')
      if (key === cacheKey) return cache
      cacheKey = key
      cache = sections
      return sections
    },
  )
}

const EMPTY: Section[] = []
let cache: Section[] = EMPTY
let cacheKey = ''

/**
 * スクロールに合わせて現在地を出す。
 *
 * ⚠️ **位置を先に測って憶えない。** マウント直後は本文がまだ組み上がっておらず、
 * `offsetTop` がすべて 0 に近い値になって現在地が末尾に張り付く (実機で発生)。
 * スクロールのたびに矩形を読み、rAF で 1 フレーム 1 回に間引く。
 */
function useCurrentSection(sections: Section[]): number {
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    const scroller = document.querySelector('.main')
    const view = activeEditorView()
    if (!(scroller instanceof HTMLElement) || view === null || sections.length === 0) return undefined

    let frame = 0
    const measure = (): void => {
      frame = 0
      const top = scroller.getBoundingClientRect().top + 90
      let at = 0
      for (const [i, section] of sections.entries()) {
        const dom = view.nodeDOM(section.pos)
        if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= top) at = i
      }
      setCurrent(at)
    }
    const onScroll = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [sections])

  return current
}

function Toc(): JSX.Element {
  const sections = useSections()
  const current = useCurrentSection(sections)

  return (
    <section className="panel-section">
      <h2 className="panel-title"><List size={13} /> 目次{sections.length === 0 ? '' : ` (${String(sections.length)})`}</h2>
      {sections.length === 0 ? (
        <p className="panel-note">見出しがありません</p>
      ) : (
        <ul className="toc-list">
          {sections.map((section, index) => (
            <li key={`${String(section.pos)}:${section.text}`}>
              <div
                className={`toc-row level-${String(Math.min(section.level, 4))}${index === current ? ' is-current' : ''}`}
              >
                <button
                  type="button"
                  className="toc-fold"
                  aria-label={section.folded ? '節を開く' : '節を畳む'}
                  aria-expanded={!section.folded}
                  data-idle={!section.foldable}
                  onClick={() => {
                    const view = activeEditorView()
                    if (view !== null) toggleHeadingFoldAt(view, section.pos)
                  }}
                />
                <button
                  type="button"
                  className="toc-link"
                  onClick={() => {
                    const view = activeEditorView()
                    if (view === null) return
                    const dom = view.nodeDOM(section.pos)
                    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
                  }}
                >
                  {section.text === '' ? '(無題)' : section.text}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 見出しの折りたたみと目次 (task #11)。
 *
 * 目次は**エディタの状態から作る** (DOM を読まない)。折りたたみで隠れている見出しは
 * 目次にも出ないので、画面に見えている構造と目次が必ず一致する。
 */
export default defineUiFeature({
  name: 'toc',
  editor: { order: 'after-preset', plugins: headingFold },
  panelSection: () => <Toc />,
})
