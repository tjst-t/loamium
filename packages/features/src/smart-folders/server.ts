import { parseQuery, runQuery, QueryError, type QueryNote } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { SMART_FOLDER_DIR, type SmartFolder, type SmartFolderResult } from './contract'

/**
 * スマートフォルダ (task #25 / ADR-0001〜0005)。
 *
 * 「条件で集まるフォルダ」を **vault の中の普通の YAML** (`smart-folders/<id>.yaml`) で持つ。
 * アプリの設定ファイルではないので、vault を別の場所へ移してもキャッシュを消しても残る。
 *
 * 中身は dataview と**同じクエリ文字列**。仕組みを二重に持たない (ADR-0001)。
 */

const fileOf = (id: string): string => `${SMART_FOLDER_DIR}/${id}.yaml`

/** ファイル名から id を取る (`smart-folders/todos.yaml` → `todos`) */
const idOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/i, '')

function toFolder(id: string, raw: unknown): SmartFolder | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const query = typeof record['query'] === 'string' ? record['query'] : null
  if (query === null) return null
  const folder: SmartFolder = {
    id: typeof record['id'] === 'string' ? record['id'] : id,
    name: typeof record['name'] === 'string' ? record['name'] : id,
    query,
  }
  if (typeof record['icon'] === 'string') folder.icon = record['icon']
  if (typeof record['order'] === 'number') folder.order = record['order']
  return folder
}

async function listFolders(ctx: Context): Promise<SmartFolder[]> {
  const files = (await ctx.vault.listFiles())
    .filter((file) => file.path.startsWith(`${SMART_FOLDER_DIR}/`) && /\.ya?ml$/i.test(file.path))
  const folders = await Promise.all(files.map(async (file) => {
    try {
      return toFolder(idOf(file.path), parseYaml(await ctx.vault.read(file.path)))
    } catch {
      return null // 1 つ壊れていても他は出す
    }
  }))
  return folders
    .filter((folder): folder is SmartFolder => folder !== null)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name, 'ja'))
}

async function notesOf(ctx: Context): Promise<QueryNote[]> {
  const paths = ctx.noteIndex.paths()
  const notes = await Promise.all(paths.map(async (path): Promise<QueryNote | null> => {
    try {
      const mtime = await ctx.vault.mtime(path)
      const note: QueryNote = { path, content: await ctx.vault.read(path) }
      return mtime === undefined ? note : { ...note, mtime }
    } catch {
      return null
    }
  }))
  return notes.filter((note): note is QueryNote => note !== null)
}

async function runFolder(ctx: Context, id: string): Promise<SmartFolderResult | null> {
  const folder = (await listFolders(ctx)).find((entry) => entry.id === id)
  if (folder === undefined) return null
  try {
    return { folder, result: runQuery(parseQuery(folder.query), await notesOf(ctx)) }
  } catch (error: unknown) {
    if (error instanceof QueryError) return { folder, error: error.message }
    throw error
  }
}

/** 保存。**クエリを先に検算する** (壊れたものをファイルに残さない) */
async function saveFolder(ctx: Context, folder: SmartFolder): Promise<SmartFolder> {
  parseQuery(folder.query)
  const body: Record<string, unknown> = { id: folder.id, name: folder.name, query: folder.query }
  if (folder.icon !== undefined) body['icon'] = folder.icon
  if (folder.order !== undefined) body['order'] = folder.order
  await ctx.vault.writeBytes(fileOf(folder.id), new TextEncoder().encode(stringifyYaml(body)))
  return folder
}

const slug = (text: string): string =>
  text.trim().replace(/[\\/:*?"<>|.]/g, '-').replace(/\s+/g, '-') || 'folder'

export const smartFoldersFeature = defineFeature({
  name: 'smartFolders',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/smart-folders', async (c) => c.json({ folders: await listFolders(ctx) }))

    app.get('/api/smart-folders/:id/run', async (c) => {
      const found = await runFolder(ctx, c.req.param('id'))
      return found === null ? c.json({ error: 'not_found' }, 404) : c.json(found)
    })

    app.post('/api/smart-folders', async (c) => {
      const raw: unknown = await c.req.json()
      const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      const query = typeof body['query'] === 'string' ? body['query'].trim() : ''
      if (name === '' || query === '') return c.json({ error: 'name_and_query_required' }, 400)
      const folder: SmartFolder = {
        id: typeof body['id'] === 'string' && body['id'] !== '' ? slug(body['id']) : slug(name),
        name,
        query,
      }
      if (typeof body['icon'] === 'string') folder.icon = body['icon']
      if (typeof body['order'] === 'number') folder.order = body['order']
      try {
        return c.json(await saveFolder(ctx, folder))
      } catch (error: unknown) {
        // 壊れたクエリは保存しない (あとで「なぜか 0 件」になるより、いま断る)
        return c.json({ error: error instanceof Error ? error.message : 'invalid_query' }, 400)
      }
    })

    app.delete('/api/smart-folders/:id', async (c) => {
      const id = c.req.param('id')
      await ctx.vault.remove(fileOf(id))
      return c.json({ id, removed: true })
    })
  },

  tools: [
    {
      name: 'list_smart_folders',
      description: 'スマートフォルダ (保存したクエリ) の一覧を返す。',
      capability: 'read',
      run: async (ctx) => ({ folders: await listFolders(ctx) }),
    },
    {
      name: 'run_smart_folder',
      description: 'スマートフォルダのクエリを走らせて、当てはまるノートを返す。',
      capability: 'read',
      parameters: { id: { type: 'string', description: 'スマートフォルダの id', required: true } },
      run: async (ctx, args) => {
        const found = await runFolder(ctx, String(args['id']))
        if (found === null) throw new Error(`スマートフォルダが見つかりません: ${String(args['id'])}`)
        return found
      },
    },
    {
      name: 'save_smart_folder',
      description: 'スマートフォルダを作る / 書き換える (vault の smart-folders/*.yaml)。',
      capability: 'write',
      parameters: {
        name: { type: 'string', description: '表示名', required: true },
        query: { type: 'string', description: 'dataview と同じクエリ', required: true },
        id: { type: 'string', description: 'ファイル名にする id (省略すると名前から作る)' },
        icon: { type: 'string', description: 'lucide のアイコン名' },
        order: { type: 'number', description: '並び順 (小さいほど上)' },
      },
      run: async (ctx, args) => {
        const name = String(args['name'])
        const folder: SmartFolder = {
          id: typeof args['id'] === 'string' && args['id'] !== '' ? slug(args['id']) : slug(name),
          name,
          query: String(args['query']),
        }
        if (typeof args['icon'] === 'string') folder.icon = args['icon']
        if (typeof args['order'] === 'number') folder.order = args['order']
        return saveFolder(ctx, folder)
      },
    },
    {
      name: 'delete_smart_folder',
      description: 'スマートフォルダを消す (ノートは消えない)。',
      capability: 'write',
      parameters: { id: { type: 'string', description: 'スマートフォルダの id', required: true } },
      run: async (ctx, args) => {
        const id = String(args['id'])
        await ctx.vault.remove(fileOf(id))
        return { id, removed: true }
      },
    },
  ],

  help: [
    {
      name: 'smart-folders',
      body: `# スマートフォルダ

「条件で集まるフォルダ」です。中身は [[dataview]] と**同じクエリ文字列**で、
vault の \`smart-folders/<id>.yaml\` に置かれます。

\`\`\`yaml
id: todos
name: 未完了TODO
icon: flame
query: LIST WHERE file.open_tasks SORT file.mtime DESC
order: 3
\`\`\`

アプリの設定ファイルではないので、vault を移してもキャッシュを消しても残ります。

## ツール

- \`list_smart_folders\` — 一覧
- \`run_smart_folder\` — そのフォルダのクエリを走らせる
- \`save_smart_folder\` — 作る / 書き換える (**クエリが壊れていれば保存しません**)
- \`delete_smart_folder\` — 消す (ノートは消えません)
`,
    },
  ],
})
