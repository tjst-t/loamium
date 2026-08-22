/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '../app'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-app-'))
  await mkdir(join(root, '日誌'), { recursive: true })
  await writeFile(join(root, 'table.md'), '|a|b|\n|---|---|\n|x|y|\n')
  await writeFile(join(root, 'ok.md'), '# ok\n')
  await writeFile(join(root, '日誌/list.md'), '-   ゆるい\n')
  // port 0 = OS 任せ。テストは http.fetch を直接叩くのでポートは使わない
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: notes', () => {
  it('GET /api/health', async () => {
    expect(await (await call('/api/health')).json()).toMatchObject({ ok: true, notes: 3 })
  })

  it('GET /api/notes', async () => {
    const body = (await (await call('/api/notes')).json()) as { paths: string[] }
    expect(body.paths.sort()).toEqual(['ok.md', 'table.md', '日誌/list.md'])
  })

  it('GET /api/notes/:path で日本語パスが読める', async () => {
    const r = await call(`/api/notes/${encodeURI('日誌/list.md')}`)
    expect(await r.text()).toBe('-   ゆるい\n')
  })

  it('存在しないノートは 404', async () => {
    expect((await call('/api/notes/nope.md')).status).toBe(404)
  })

  it('URL エンコードした .. は 400 (vault 脱出の防止)', async () => {
    const r = await call('/api/notes/%2e%2e%2f%2e%2e%2fetc%2fhostname')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'invalid_path' })
  })

  it('POST は normalizeForSave を通す', async () => {
    await call('/api/notes/new.md', { method: 'POST', body: '|a|b|\n|---|---|\n|x||\n' })
    expect(await readFile(join(root, 'new.md'), 'utf8')).toBe('| a | b |\n| - | - |\n| x | |\n')
  })
})

describe('REST: fmt', () => {
  it('dry-run はファイルを書き換えない', async () => {
    const before = await readFile(join(root, 'table.md'), 'utf8')
    const body = (await (await call('/api/vault/fmt?dry-run=1', { method: 'POST' })).json()) as
      { scanned: number; changed: string[]; dryRun: boolean }
    expect(body.dryRun).toBe(true)
    expect(body.scanned).toBe(3)
    expect(body.changed.sort()).toEqual(['table.md', '日誌/list.md'])
    expect(await readFile(join(root, 'table.md'), 'utf8')).toBe(before)
  })

  it('実行すると正規化され、二度目は変化なし (冪等)', async () => {
    const first = (await (await call('/api/vault/fmt', { method: 'POST' })).json()) as { changed: string[] }
    expect(first.changed).toHaveLength(2)
    expect(await readFile(join(root, 'table.md'), 'utf8')).toBe('| a | b |\n| - | - |\n| x | y |\n')

    const second = (await (await call('/api/vault/fmt', { method: 'POST' })).json()) as { changed: string[] }
    expect(second.changed).toEqual([])
  })
})

describe('REST: agent', () => {
  it('全機能のツールが登録されている', async () => {
    const body = (await (await call('/api/agent/tools')).json()) as { tools: { name: string }[] }
    expect(body.tools.map((t) => t.name).sort()).toEqual(
      [
        'fmt_vault', 'folder_create', 'help', 'journal_append', 'journal_read',
        'list_notes', 'list_tree', 'note_create', 'note_delete', 'note_move',
        'read_note', 'write_note',
      ],
    )
  })

  it('ケーパビリティで絞れる (ADR-0015)', async () => {
    const body = (await (await call('/api/agent/tools?capability=read')).json()) as { tools: { name: string }[] }
    expect(body.tools.map((t) => t.name).sort()).toEqual(
      ['help', 'journal_read', 'list_notes', 'list_tree', 'read_note'])
  })

  it('help トピックが機能ごとに登録されている (ADR-0014)', async () => {
    const body = (await (await call('/api/agent/help')).json()) as { topics: string[] }
    expect(body.topics.sort()).toEqual(['fmt', 'help', 'journal', 'notes'])
  })

  it('help 本文はピュア Markdown で返る', async () => {
    expect(await (await call('/api/agent/help/fmt')).text()).toContain('# vault の正規化')
  })
})

describe('ツールの実行はケーパビリティで守られる', () => {
  it('write ケーパビリティが無ければ write_note は拒否される', async () => {
    await expect(ctx.tools.invoke('write_note', { path: 'x.md', content: '# x' }, ['read']))
      .rejects.toThrow(/ケーパビリティが不足/)
  })

  it('granted されていれば実行できる', async () => {
    await ctx.tools.invoke('write_note', { path: 'x.md', content: '# x' }, ['read', 'write'])
    expect(await readFile(join(root, 'x.md'), 'utf8')).toBe('# x\n')
  })

  it('ツールは監査済みサービス層を経由する (ADR-0016)', async () => {
    await ctx.tools.invoke('write_note', { path: 'x.md', content: '# x' }, ['write'])
    expect(await readFile(join(root, '.loamium/audit.log'), 'utf8')).toContain('"path":"x.md"')
  })

  it('ツール経由でも vault 脱出は拒否される', async () => {
    await expect(ctx.tools.invoke('read_note', { path: '../../etc/hostname' }, ['read']))
      .rejects.toThrow(/vault の外/)
  })
})

describe('REST: ツリーと基本操作', () => {
  const json = async (path: string, init?: RequestInit): Promise<unknown> =>
    (await call(path, init)).json()

  it('GET /api/tree はフォルダ先・名前順の階層を返す', async () => {
    const body = (await json('/api/tree')) as { tree: { name: string; type: string; children?: unknown[] }[] }
    expect(body.tree.map((n) => `${n.type}:${n.name}`)).toEqual(['folder:日誌', 'note:ok.md', 'note:table.md'])
    expect(body.tree[0]?.children).toHaveLength(1)
  })

  it('PUT で新規作成し、二度目は 409', async () => {
    expect((await call('/api/notes/新規.md', { method: 'PUT', body: '# 新規' })).status).toBe(200)
    expect(await readFile(join(root, '新規.md'), 'utf8')).toBe('# 新規\n')
    const dup = await call('/api/notes/新規.md', { method: 'PUT', body: '# 別' })
    expect(dup.status).toBe(409)
    expect(await readFile(join(root, '新規.md'), 'utf8')).toBe('# 新規\n')
  })

  it('POST /move はリネームし、インデックスも追従する', async () => {
    const r = await call('/api/move', {
      method: 'POST', body: JSON.stringify({ from: 'ok.md', to: '日誌/renamed.md' }),
    })
    expect(r.status).toBe(200)
    const paths = ((await json('/api/notes')) as { paths: string[] }).paths
    expect(paths.sort()).toEqual(['table.md', '日誌/list.md', '日誌/renamed.md'])
  })

  it('移動先が既にあれば 409 で、元ファイルは残る', async () => {
    const r = await call('/api/move', {
      method: 'POST', body: JSON.stringify({ from: 'ok.md', to: 'table.md' }),
    })
    expect(r.status).toBe(409)
    expect(await readFile(join(root, 'ok.md'), 'utf8')).toBe('# ok\n')
  })

  it('存在しないノートの移動は 404', async () => {
    const r = await call('/api/move', {
      method: 'POST', body: JSON.stringify({ from: 'nope.md', to: 'x.md' }),
    })
    expect(r.status).toBe(404)
  })

  it('DELETE でノートが消え、インデックスからも消える', async () => {
    expect((await call('/api/notes/ok.md', { method: 'DELETE' })).status).toBe(200)
    const paths = ((await json('/api/notes')) as { paths: string[] }).paths
    expect(paths.sort()).toEqual(['table.md', '日誌/list.md'])
  })

  it('フォルダを作成・削除できる (削除は中身ごと)', async () => {
    expect((await call('/api/folders/新フォルダ', { method: 'POST' })).status).toBe(200)
    const tree = ((await json('/api/tree')) as { tree: { name: string }[] }).tree
    expect(tree.map((n) => n.name)).toContain('新フォルダ')

    expect((await call('/api/folders/日誌', { method: 'DELETE' })).status).toBe(200)
    const paths = ((await json('/api/notes')) as { paths: string[] }).paths
    expect(paths.sort()).toEqual(['ok.md', 'table.md'])
  })

  it('vault 脱出は移動・削除でも拒否される', async () => {
    expect((await call('/api/notes/%2e%2e%2fescaped.md', { method: 'DELETE' })).status).toBe(400)
    const r = await call('/api/move', {
      method: 'POST', body: JSON.stringify({ from: 'ok.md', to: '../escaped.md' }),
    })
    expect(r.status).toBe(400)
  })
})

describe('REST: journal', () => {
  const today = (): string => {
    const n = new Date()
    return `${n.getFullYear()}-${`${n.getMonth() + 1}`.padStart(2, '0')}-${`${n.getDate()}`.padStart(2, '0')}`
  }

  it('GET /api/journal は今日のジャーナルを遅延生成する', async () => {
    const body = (await (await call('/api/journal')).json()) as
      { date: string; path: string; content: string; created: boolean }
    expect(body.date).toBe(today())
    expect(body.path).toBe(`journals/${today()}.md`)
    expect(body.created).toBe(true)
    expect(body.content).toBe(`# ${today()}\n`)
    expect(await readFile(join(root, body.path), 'utf8')).toBe(`# ${today()}\n`)
  })

  it('二度目は作り直さない (created=false)', async () => {
    await call('/api/journal')
    await call(`/api/notes/${encodeURI(`journals/${today()}.md`)}`, { method: 'POST', body: '# 書いた\n' })
    const body = (await (await call('/api/journal')).json()) as { created: boolean; content: string }
    expect(body.created).toBe(false)
    expect(body.content).toBe('# 書いた\n')
  })

  it('date で相対指定できる', async () => {
    const body = (await (await call('/api/journal?date=yesterday')).json()) as { date: string }
    const y = new Date()
    y.setDate(y.getDate() - 1)
    expect(body.date).toBe(
      `${y.getFullYear()}-${`${y.getMonth() + 1}`.padStart(2, '0')}-${`${y.getDate()}`.padStart(2, '0')}`)
  })

  it('不正な日付は 400', async () => {
    const r = await call('/api/journal?date=来週')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'invalid_date' })
  })

  it('POST /api/journal/append は末尾に追記する (既存を消さない)', async () => {
    await call('/api/journal')
    await call('/api/journal/append', { method: 'POST', body: JSON.stringify({ text: '- 1 件目' }) })
    await call('/api/journal/append', { method: 'POST', body: JSON.stringify({ text: '- 2 件目' }) })
    expect(await readFile(join(root, `journals/${today()}.md`), 'utf8'))
      .toBe(`# ${today()}\n\n- 1 件目\n\n- 2 件目\n`)
  })

  it('append は無ければ作る', async () => {
    await call('/api/journal/append', {
      method: 'POST', body: JSON.stringify({ text: '- メモ', date: '2026-01-05' }),
    })
    expect(await readFile(join(root, 'journals/2026-01-05.md'), 'utf8'))
      .toBe('# 2026-01-05\n\n- メモ\n')
  })

  it('空文字の追記は 400 (誤爆でファイルを汚さない)', async () => {
    const r = await call('/api/journal/append', { method: 'POST', body: JSON.stringify({ text: '  ' }) })
    expect(r.status).toBe(400)
  })
})
