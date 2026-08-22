const BASE = import.meta.env['VITE_API_BASE'] ?? ''

/** vault のフォルダ階層。サーバー (VaultService.tree) と同じ形 */
export interface TreeNode {
  name: string
  path: string
  type: 'folder' | 'note'
  children?: TreeNode[]
}

/** REST のエラー本文をそのままユーザーに見せられる形にする (409 の「すでに存在します」等) */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(message: string, readonly status: number) { super(message) }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${BASE}${path}`, init)
  if (!r.ok) {
    let message = `${r.status}`
    try {
      const body = (await r.json()) as { message?: string; error?: string }
      message = body.message ?? body.error ?? message
    } catch { /* 本文が JSON でないことはある */ }
    throw new ApiError(message, r.status)
  }
  return r
}

export async function listNotes(): Promise<string[]> {
  const r = await request('/api/notes')
  return ((await r.json()) as { paths: string[] }).paths
}

export async function fetchTree(): Promise<TreeNode[]> {
  const r = await request('/api/tree')
  return ((await r.json()) as { tree: TreeNode[] }).tree
}

export interface Journal {
  date: string
  path: string
  content: string
  /** 遅延生成でこの取得時に作られたか (作られたらツリーを引き直す) */
  created: boolean
}

/** デイリージャーナルを取得する。無ければサーバー側で作られる */
export async function fetchJournal(date?: string): Promise<Journal> {
  const q = date === undefined ? '' : `?date=${encodeURIComponent(date)}`
  const r = await request(`/api/journal${q}`)
  return (await r.json()) as Journal
}

export interface SearchHit {
  path: string
  /** 1 始まりの行番号。ファイル名の一致なら 0 */
  line: number
  snippet: string
  match: { start: number; length: number }
  kind: 'title' | 'body'
}

export interface SearchFilters {
  /** このタグが付いたノートだけ。親タグは子タグにも一致する */
  tag?: string
  /** このフォルダ配下だけ */
  folder?: string
}

export async function searchNotes(
  query: string, filters: SearchFilters = {},
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const params = new URLSearchParams({ q: query })
  if (filters.tag !== undefined && filters.tag !== '') params.set('tag', filters.tag)
  if (filters.folder !== undefined && filters.folder !== '') params.set('folder', filters.folder)
  const r = await request(`/api/search?${params.toString()}`)
  return (await r.json()) as { hits: SearchHit[]; truncated: boolean }
}

export async function readNote(path: string): Promise<string> {
  return (await request(`/api/notes/${encodeURI(path)}`)).text()
}

export async function writeNote(path: string, body: string): Promise<void> {
  await request(`/api/notes/${encodeURI(path)}`, { method: 'POST', body })
}

/** 新規作成。既存があれば 409 (上書きしない) */
export async function createNote(path: string, body = ''): Promise<void> {
  await request(`/api/notes/${encodeURI(path)}`, { method: 'PUT', body })
}

export async function createFolder(path: string): Promise<void> {
  await request(`/api/folders/${encodeURI(path)}`, { method: 'POST' })
}

/** リネームと移動は同じ操作。ノートでもフォルダでも使える */
export async function movePath(from: string, to: string): Promise<void> {
  await request('/api/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
}

export async function removePath(path: string, type: 'folder' | 'note'): Promise<void> {
  const base = type === 'folder' ? '/api/folders' : '/api/notes'
  await request(`${base}/${encodeURI(path)}`, { method: 'DELETE' })
}

export interface Backlink {
  path: string
  line: number
  snippet: string
  raw: string
}

/** そのノートを指している [[リンク]] (task #6) */
export async function fetchBacklinks(path: string): Promise<Backlink[]> {
  const r = await request(`/api/backlinks?path=${encodeURIComponent(path)}`)
  return ((await r.json()) as { backlinks: Backlink[] }).backlinks
}

export interface OutgoingLink {
  target: string
  heading: string | null
  alias: string | null
  /** 解決できた vault パス。null なら壊れリンク */
  path: string | null
  line: number
}

export async function fetchLinks(path: string): Promise<OutgoingLink[]> {
  const r = await request(`/api/links?path=${encodeURIComponent(path)}`)
  return ((await r.json()) as { links: OutgoingLink[] }).links
}

export interface TagCount {
  tag: string
  count: number
}

/** vault で使われているタグと件数 (多い順) */
export async function fetchTags(): Promise<TagCount[]> {
  const r = await request('/api/tags')
  return ((await r.json()) as { tags: TagCount[] }).tags
}
