/** CLI は REST API を叩くだけの薄いラッパー。エンドポイントと 1:1 で対応させる。 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(message: string, readonly status: number) { super(message) }
}

export function baseUrl(): string {
  return process.env['LOAMIUM_URL'] ?? `http://127.0.0.1:${process.env['PORT'] ?? 8200}`
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${baseUrl()}${path}`, init)
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { message?: string; error?: string }
      detail = body.message ?? body.error ?? ''
    } catch { /* 本文が JSON でないことはある */ }
    throw new ApiError(`${init?.method ?? 'GET'} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
  }
  return res
}

export const api = {
  async listNotes(): Promise<string[]> {
    const r = await request('/api/notes')
    return ((await r.json()) as { paths: string[] }).paths
  },
  async readNote(path: string): Promise<string> {
    return (await request(`/api/notes/${encodeURI(path)}`)).text()
  },
  async writeNote(path: string, body: string): Promise<void> {
    await request(`/api/notes/${encodeURI(path)}`, { method: 'POST', body })
  },
  async fmt(dryRun: boolean): Promise<{ scanned: number; changed: string[]; dryRun: boolean }> {
    const r = await request(`/api/vault/fmt${dryRun ? '?dry-run=1' : ''}`, { method: 'POST' })
    return (await r.json()) as { scanned: number; changed: string[]; dryRun: boolean }
  },
  async tools(): Promise<{ name: string; description: string; capability: string }[]> {
    const r = await request('/api/agent/tools')
    return ((await r.json()) as { tools: { name: string; description: string; capability: string }[] }).tools
  },
  async helpTopics(): Promise<string[]> {
    const r = await request('/api/agent/help')
    return ((await r.json()) as { topics: string[] }).topics
  },
  async help(topic: string): Promise<string> {
    return (await request(`/api/agent/help/${encodeURIComponent(topic)}`)).text()
  },
}
