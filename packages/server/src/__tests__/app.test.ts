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
        'delete_file', 'find_broken_links', 'fmt_vault', 'folder_create', 'get_properties',
        'help', 'journal_append', 'journal_read', 'list_backlinks', 'list_bookmarks', 'list_files',
        'list_links', 'list_notes', 'list_property_keys', 'list_tags', 'list_tree', 'note_create',
        'note_delete', 'note_move', 'notes_by_tag', 'read_embed', 'read_file', 'read_note',
        'remove_property', 'search', 'set_bookmark', 'set_property', 'write_note',
      ],
    )
  })

  it('ケーパビリティで絞れる (ADR-0015)', async () => {
    const body = (await (await call('/api/agent/tools?capability=read')).json()) as { tools: { name: string }[] }
    expect(body.tools.map((t) => t.name).sort()).toEqual(
      [
        'find_broken_links', 'get_properties', 'help', 'journal_read', 'list_backlinks',
        'list_bookmarks', 'list_files', 'list_links', 'list_notes', 'list_property_keys',
        'list_tags', 'list_tree', 'notes_by_tag', 'read_embed', 'read_file', 'read_note', 'search',
      ])
  })

  it('help トピックが機能ごとに登録されている (ADR-0014)', async () => {
    const body = (await (await call('/api/agent/help')).json()) as { topics: string[] }
    expect(body.topics.sort()).toEqual([
      'bookmarks', 'embed', 'files', 'fmt', 'help', 'journal', 'links', 'notes', 'properties',
      'search', 'tags',
    ])
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

describe('REST: search', () => {
  type Hits = { query: string; hits: { path: string; line: number; snippet: string; kind: string }[]
    truncated: boolean }

  it('本文を横断して行番号つきで返す', async () => {
    const body = (await (await call(`/api/search?q=${encodeURIComponent('ゆるい')}`)).json()) as Hits
    expect(body.hits).toEqual([
      { path: '日誌/list.md', line: 1, snippet: '-   ゆるい', match: { start: 4, length: 3 }, kind: 'body' },
    ])
  })

  it('ファイル名の一致を本文より上に出す', async () => {
    await call('/api/notes/ok.md', { method: 'POST', body: '# ok\n\nokay\n' })
    const body = (await (await call('/api/search?q=ok')).json()) as Hits
    expect(body.hits[0]).toMatchObject({ path: 'ok.md', kind: 'title', line: 0 })
    expect(body.hits.some((h) => h.kind === 'body')).toBe(true)
  })

  it('一致が無ければ空', async () => {
    const body = (await (await call('/api/search?q=存在しない語')).json()) as Hits
    expect(body.hits).toEqual([])
  })

  it('空クエリは走査せず空を返す', async () => {
    const body = (await (await call('/api/search?q=')).json()) as Hits
    expect(body).toMatchObject({ query: '', hits: [], truncated: false })
  })

  it('limit で打ち切り、truncated が立つ', async () => {
    await call('/api/notes/many.md', { method: 'POST', body: 'x\nx\nx\nx\n' })
    const body = (await (await call('/api/search?q=x&limit=2')).json()) as Hits
    expect(body.hits).toHaveLength(2)
    expect(body.truncated).toBe(true)
  })

  it('外部で書き換えた内容がすぐ反映される (索引をキャッシュしない)', async () => {
    await writeFile(join(root, 'ok.md'), '# ok\n\n外から書いた語\n')
    const body = (await (await call(`/api/search?q=${encodeURIComponent('外から書いた語')}`)).json()) as Hits
    expect(body.hits.map((h) => h.path)).toEqual(['ok.md'])
  })
})

describe('REST: links / backlinks (task #4, #6)', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'hub.md'), '# hub\n\n- [[ok]] を見る\n- [[日誌/list|一覧]]\n- [[存在しない]]\n')
    await writeFile(join(root, '日誌/mention.md'), '[[ok#見出し]] を参照\n')
    // インデックスはファイル走査で作られるので、書いたあとに作り直す
    await ctx.noteIndex.start()
  })

  it('GET /api/backlinks でリンク元が行番号つきで返る', async () => {
    const r = await call(`/api/backlinks?path=${encodeURIComponent('ok.md')}`)
    const body = (await r.json()) as { backlinks: { path: string; line: number; raw: string }[] }
    expect(body.backlinks).toEqual([
      { path: 'hub.md', line: 3, snippet: '- [[ok]] を見る', raw: '[[ok]]' },
      { path: '日誌/mention.md', line: 1, snippet: '[[ok#見出し]] を参照', raw: '[[ok#見出し]]' },
    ])
  })

  it('リンクされていないノートのバックリンクは空', async () => {
    const r = await call(`/api/backlinks?path=${encodeURIComponent('table.md')}`)
    expect(await r.json()).toMatchObject({ backlinks: [] })
  })

  it('path が無ければ 400', async () => {
    expect((await call('/api/backlinks')).status).toBe(400)
  })

  it('GET /api/links は出ているリンクを解決して返す (壊れリンクは path: null)', async () => {
    const r = await call(`/api/links?path=${encodeURIComponent('hub.md')}`)
    const body = (await r.json()) as { links: { target: string; path: string | null }[] }
    expect(body.links).toEqual([
      { target: 'ok', heading: null, alias: null, path: 'ok.md', line: 3 },
      { target: '日誌/list', heading: null, alias: '一覧', path: '日誌/list.md', line: 4 },
      { target: '存在しない', heading: null, alias: null, path: null, line: 5 },
    ])
  })

  it('GET /api/broken-links は vault 全体の壊れリンクを返す', async () => {
    const r = await call('/api/broken-links')
    expect(await r.json()).toMatchObject({ broken: [{ from: 'hub.md', target: '存在しない', line: 5 }] })
  })
})

describe('リネームすると [[リンク]] が追従する (task #5)', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'hub.md'), '[[ok]] と [[ok|表示名]] と [[ok#見出し]]\n\n```md\n[[ok]]\n```\n')
    await ctx.noteIndex.start()
  })

  it('リンク先の書き換えで見出しと表示名は保たれる', async () => {
    await call('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'ok.md', to: 'renamed.md' }),
    })
    expect(await readFile(join(root, 'hub.md'), 'utf8'))
      .toBe('[[renamed]] と [[renamed|表示名]] と [[renamed#見出し]]\n\n```md\n[[ok]]\n```\n')
  })

  it('更新したファイルを応答で返す', async () => {
    const r = await call('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'ok.md', to: 'renamed.md' }),
    })
    expect(await r.json()).toMatchObject({ ok: true, linksUpdated: ['hub.md'] })
  })

  it('フォルダを跨いで動かしてもノート名が変わらなければ本文はそのまま (無駄な diff を作らない)', async () => {
    const r = await call('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'ok.md', to: '日誌/ok.md' }),
    })
    expect(await r.json()).toMatchObject({ linksUpdated: [] })
    expect(await readFile(join(root, 'hub.md'), 'utf8')).toContain('[[ok]]')
  })

  it('フォルダごと動かしても追従する', async () => {
    await writeFile(join(root, 'hub.md'), '[[日誌/list]] と [[list]]\n')
    await ctx.noteIndex.start()
    await call('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '日誌', to: 'diary' }),
    })
    expect(await readFile(join(root, 'hub.md'), 'utf8')).toBe('[[diary/list]] と [[list]]\n')
  })
})

describe('REST: tags (task #9)', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'work.md'), '---\ntags: [仕事]\n---\n\n#読書/SF のメモ\n')
    await writeFile(join(root, '日誌/day.md'), '今日は #仕事 をした\n')
    await ctx.noteIndex.start()
  })

  it('GET /api/tags は件数つきで多い順に返る', async () => {
    const body = (await (await call('/api/tags')).json()) as { tags: { tag: string; count: number }[] }
    expect(body.tags).toEqual([
      { tag: '仕事', count: 2 },
      { tag: '読書/SF', count: 1 },
    ])
  })

  it('GET /api/tags/notes でそのタグのノートが返る (親タグは子にも一致)', async () => {
    const r = await call(`/api/tags/notes?tag=${encodeURIComponent('読書')}`)
    const body = (await r.json()) as { notes: { path: string }[] }
    expect(body.notes.map((n) => n.path)).toEqual(['work.md'])
  })

  it('tag が無ければ 400', async () => {
    expect((await call('/api/tags/notes')).status).toBe(400)
  })
})

describe('REST: search の絞り込み (task #8)', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'work.md'), '#仕事\n\nメモを書く\n')
    await writeFile(join(root, '日誌/day.md'), 'メモを書く\n')
    await ctx.noteIndex.start()
  })

  it('folder で絞れる', async () => {
    const r = await call(`/api/search?q=${encodeURIComponent('メモ')}&folder=${encodeURIComponent('日誌')}`)
    const body = (await r.json()) as { hits: { path: string }[] }
    expect([...new Set(body.hits.map((h) => h.path))]).toEqual(['日誌/day.md'])
  })

  it('tag で絞れる', async () => {
    const r = await call(`/api/search?q=${encodeURIComponent('メモ')}&tag=${encodeURIComponent('仕事')}`)
    const body = (await r.json()) as { hits: { path: string }[] }
    expect([...new Set(body.hits.map((h) => h.path))]).toEqual(['work.md'])
  })

  it('検索語が空でもタグだけで一覧できる', async () => {
    const r = await call(`/api/search?q=&tag=${encodeURIComponent('仕事')}`)
    const body = (await r.json()) as { hits: { path: string; kind: string }[] }
    expect(body.hits).toEqual([{
      path: 'work.md', line: 0, snippet: 'work.md', match: { start: 0, length: 0 }, kind: 'title',
    }])
  })

  it('条件が何も無ければ空 (vault 全件を返さない)', async () => {
    expect(await (await call('/api/search?q=')).json()).toMatchObject({ hits: [] })
  })
})
