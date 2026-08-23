/** @vitest-environment node */
/**
 * タスク (task #19 / ADR-0029)。
 * 肝は **語彙をコードに埋めない**ことと、完了と status が互いに追従すること。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createApp } from '@loamium/server/src/app'

let root: string
let ctx: Context
const call = (path: string, init?: RequestInit): Promise<Response> =>
  ctx.http.fetch(new Request(`http://test${path}`, init)) as Promise<Response>
const patch = (body: unknown): Promise<Response> => call('/api/tasks', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const read = (): Promise<string> => readFile(join(root, 'やること.md'), 'utf8')

const NOTE = [
  '# やること',
  '',
  '- [ ] 資料を集める',
  '- [ ] レビュー [status:: progress] [priority:: high]',
  '',
].join('\n')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loamium-tasks-'))
  await writeFile(join(root, 'やること.md'), NOTE)
  ctx = await createApp({ vaultRoot: root, port: 0, hostname: '127.0.0.1', logLevel: 0 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('REST: tasks', () => {
  it('タスクを行番号つきで返す', async () => {
    const body = (await (await call('/api/tasks')).json()) as { tasks: unknown[] }
    expect(body.tasks).toEqual([
      { path: 'やること.md', line: 2, checked: false, text: '資料を集める', fields: {} },
      { path: 'やること.md', line: 3, checked: false, text: 'レビュー', fields: { status: 'progress', priority: 'high' } },
    ])
  })

  it('既定の語彙を返す (設定ファイルが無くても使える)', async () => {
    const vocab = (await (await call('/api/tasks/vocab')).json()) as { status: { key: string }[] }
    expect(vocab.status.map((s) => s.key)).toEqual(['todo', 'progress', 'blocked', 'done'])
  })

  it('語彙は vault の system/settings.yaml で置き換えられる (コードに埋めない)', async () => {
    await mkdir(join(root, 'system'), { recursive: true })
    await writeFile(join(root, 'system/settings.yaml'),
      'tasks:\n  status:\n    - key: now\n      label: いま\n    - key: fin\n      label: おわり\n      done: true\n')
    const vocab = (await (await call('/api/tasks/vocab')).json()) as { status: { key: string }[]; priority: unknown[] }
    expect(vocab.status.map((s) => s.key)).toEqual(['now', 'fin'])
    // 書いていないほうは既定のまま
    expect(vocab.priority).toHaveLength(4)
  })

  it('チェックだけを変える (その行だけ)', async () => {
    expect((await patch({ path: 'やること.md', line: 2, checked: true })).status).toBe(200)
    expect((await read()).split('\n')[2]).toBe('- [x] 資料を集める')
  })

  it('done の status を付けるとチェックも入る', async () => {
    await patch({ path: 'やること.md', line: 3, key: 'status', value: 'done' })
    expect((await read()).split('\n')[3]).toBe('- [x] レビュー [status:: done] [priority:: high]')
  })

  it('チェックを入れると status も完了側に寄る', async () => {
    await patch({ path: 'やること.md', line: 3, checked: true })
    expect((await read()).split('\n')[3]).toBe('- [x] レビュー [status:: done] [priority:: high]')
    await patch({ path: 'やること.md', line: 3, checked: false })
    expect((await read()).split('\n')[3]).toBe('- [ ] レビュー [status:: todo] [priority:: high]')
  })

  it('status を持たないタスクには何も足さない', async () => {
    await patch({ path: 'やること.md', line: 2, checked: true })
    expect((await read()).split('\n')[2]).toBe('- [x] 資料を集める')
  })

  it('フィールドを消せる / 無い行はエラー', async () => {
    await patch({ path: 'やること.md', line: 3, key: 'priority' })
    expect((await read()).split('\n')[3]).toBe('- [ ] レビュー [status:: progress]')
    expect((await patch({ path: 'やること.md', line: 1, checked: true })).status).toBeGreaterThanOrEqual(400)
    expect((await patch({ path: 'やること.md' })).status).toBe(400)
  })
})

describe('エージェントツール', () => {
  it('set_task は write ケーパビリティが要る (ADR-0015)', async () => {
    await expect(ctx.tools.invoke('set_task', { path: 'やること.md', line: 2, checked: true }, ['read']))
      .rejects.toThrow(/ケーパビリティが不足/)
    await ctx.tools.invoke('set_task', { path: 'やること.md', line: 2, checked: true }, ['write'])
    expect((await read()).split('\n')[2]).toBe('- [x] 資料を集める')
  })
})
