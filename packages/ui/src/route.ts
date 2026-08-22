import { useCallback, useEffect, useState } from 'react'

/**
 * URL ルーティング (task #2)。
 *
 * 開いているノートを URL に載せる。ブラウザの戻る/進むがノート履歴になり、
 * URL をそのまま共有・ブックマークできる。ルータは入れない —
 * 状態は「開いているノートのパス」1 つだけなので History API で足りる。
 */
const PATH_PARAM = 'path'

/** URL の `?path=` から vault パスを取り出す。無ければ null */
export function pathFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(PATH_PARAM)
  if (raw === null) return null
  // 先頭の `/` は落とす (vault パスは常に相対)
  const path = raw.replace(/^\/+/, '').trim()
  return path === '' ? null : path
}

/** vault パスを `?path=…` へ。null なら空 (ルート) */
export function searchForPath(path: string | null): string {
  if (path === null) return ''
  return `?${new URLSearchParams({ [PATH_PARAM]: path }).toString()}`
}

export interface Route {
  path: string | null
  /** 履歴に積んで移動する。`replace` なら積まずに置き換える (起動直後の着地など) */
  navigate: (path: string | null, options?: { replace?: boolean }) => void
}

export function useRoute(): Route {
  const [path, setPath] = useState<string | null>(() => pathFromSearch(window.location.search))

  // 戻る/進む
  useEffect(() => {
    const onPop = (): void => { setPath(pathFromSearch(window.location.search)) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [])

  const navigate = useCallback<Route['navigate']>((next, options) => {
    const url = `${window.location.pathname}${searchForPath(next)}`
    // 同じノートを開き直しても履歴は積まない (ツリーの二度押しで戻るが効かなくなるのを防ぐ)
    const replace = options?.replace === true || next === pathFromSearch(window.location.search)
    if (replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    setPath(next)
  }, [])

  return { path, navigate }
}
