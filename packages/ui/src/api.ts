const BASE = import.meta.env['VITE_API_BASE'] ?? ''

export async function listNotes(): Promise<string[]> {
  const r = await fetch(`${BASE}/api/notes`)
  if (!r.ok) throw new Error(`listNotes: ${r.status}`)
  const body = (await r.json()) as { paths: string[] }
  return body.paths
}

export async function readNote(path: string): Promise<string> {
  const r = await fetch(`${BASE}/api/notes/${encodeURI(path)}`)
  if (!r.ok) throw new Error(`readNote: ${r.status}`)
  return r.text()
}

export async function writeNote(path: string, body: string): Promise<void> {
  const r = await fetch(`${BASE}/api/notes/${encodeURI(path)}`, { method: 'POST', body })
  if (!r.ok) throw new Error(`writeNote: ${r.status}`)
}
