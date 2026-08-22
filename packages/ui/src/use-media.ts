import { useSyncExternalStore } from 'react'

/**
 * 画面幅の区分 (CLAUDE.md のモバイル規約と同じ境界)。
 * **CSS の @media と 1 か所で揃える**ため、ここが唯一の出所。
 */
export const BREAKPOINT = {
  /** ここ以下はモバイル: 1 画面 1 面 + ドロワー */
  mobile: 680,
  /** ここ以下はタブレット: 2 面まで (右パネルはドロワー) */
  tablet: 960,
} as const

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => { list.removeEventListener('change', onChange) }
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** 1 画面 1 面。ナビゲーションも情報も、必要なときだけドロワーで出す */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${String(BREAKPOINT.mobile)}px)`)
}

/** 本文 + 左サイドバーまでは並べられるが、右パネルは重ねる */
export function useIsTablet(): boolean {
  return useMediaQuery(
    `(min-width: ${String(BREAKPOINT.mobile + 1)}px) and (max-width: ${String(BREAKPOINT.tablet)}px)`,
  )
}
