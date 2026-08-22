import { useCallback, useEffect, useState } from 'react'

/**
 * URL ルーティング (task #2)。
 *
 * 開いているノートを URL に載せる。ブラウザの戻る/進むがノート履歴になり、
 * URL をそのまま共有・ブックマークできる。ルータは入れない —
 * 状態は「開いているノートのパス」1 つだけなので History API で足りる。
 */
const PATH_PARAM = 'path'

/** 詳細検索ページの条件 (task #8)。1 つでも入っていれば検索ページを開く */
export interface SearchParams {
  q: string
  tag: string
  folder: string
}

const EMPTY_SEARCH: SearchParams = { q: '', tag: '', folder: '' }

export function searchParamsFromSearch(search: string): SearchParams | null {
  const params = new URLSearchParams(search)
  if (!['q', 'tag', 'folder'].some((key) => params.has(key))) return null
  return {
    q: params.get('q') ?? '',
    tag: params.get('tag') ?? '',
    folder: params.get('folder') ?? '',
  }
}

export function searchForQuery(params: SearchParams): string {
  const query = new URLSearchParams()
  query.set('q', params.q)
  if (params.tag !== '') query.set('tag', params.tag)
  if (params.folder !== '') query.set('folder', params.folder)
  return `?${query.toString()}`
}

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
  /** 詳細検索ページを開いているならその条件。ノートを開いているなら null */
  search: SearchParams | null
  /** 履歴に積んで移動する。`replace` なら積まずに置き換える (起動直後の着地など) */
  navigate: (path: string | null, options?: { replace?: boolean }) => void
  /** 詳細検索ページへ。条件を変えるたびに履歴を積むと戻るが使い物にならないので replace */
  navigateSearch: (params: Partial<SearchParams>, options?: { replace?: boolean }) => void
}

export function useRoute(): Route {
  const [path, setPath] = useState<string | null>(() => pathFromSearch(window.location.search))
  const [search, setSearch] = useState<SearchParams | null>(() => searchParamsFromSearch(window.location.search))

  // 戻る/進む
  useEffect(() => {
    const onPop = (): void => {
      setPath(pathFromSearch(window.location.search))
      setSearch(searchParamsFromSearch(window.location.search))
    }
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
    setSearch(null)
  }, [])

  const navigateSearch = useCallback<Route['navigateSearch']>((params, options) => {
    const next = { ...EMPTY_SEARCH, ...searchParamsFromSearch(window.location.search), ...params }
    const url = `${window.location.pathname}${searchForQuery(next)}`
    // 条件を 1 文字変えるたびに履歴を積むと戻るが使い物にならない。
    // 検索ページを**開く**ときだけ積み、条件の変更は置き換える
    const replace = options?.replace ?? searchParamsFromSearch(window.location.search) !== null
    if (replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    setPath(null)
    setSearch(next)
  }, [])

  return { path, search, navigate, navigateSearch }
}
