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
