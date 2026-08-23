import { applyPropertyEdit, readProperties } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import { BOOKMARK_KEY, type Bookmark } from './contract'

/**
 * ブックマーク (task #18 / ADR-0004)。
 *
 * 状態は**ノート自身の frontmatter** `bookmark: true`。設定ファイルの一覧にしないので、
 * ノートを別の vault へ移しても、`.loamium` を全部消しても残る。DQL からも引ける。
 *
 * プロパティの書き込みは properties 機能と同じ `applyPropertyEdit` (1 キーだけ書く)。
 */

const titleOf = (path: string, content: string): string => {
  const title = readProperties(content).find((p) => p.key === 'title')
  if (typeof title?.value === 'string' && title.value !== '') return title.value
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
}

const isOn = (content: string): boolean =>
  readProperties(content).find((p) => p.key === BOOKMARK_KEY)?.value === true

async function listBookmarks(ctx: Context): Promise<Bookmark[]> {
  const paths = ctx.noteIndex.paths()
  const found = await Promise.all(paths.map(async (path) => {
    try {
      const content = await ctx.vault.read(path)
      return isOn(content) ? { path, title: titleOf(path, content) } : null
    } catch {
      return null // 走査中に消えたファイルで全体を落とさない
    }
  }))
  return found
    .filter((b): b is Bookmark => b !== null)
    .sort((a, b) => a.title.localeCompare(b.title, 'ja'))
}

async function setBookmark(ctx: Context, path: string, on: boolean): Promise<{ path: string; bookmark: boolean }> {
  const content = await ctx.vault.read(path)
  // 外すときはキーごと消す。`bookmark: false` を残すと、ノートに意味のない行が溜まる
  await ctx.vault.write(path, applyPropertyEdit(content, on
    ? { key: BOOKMARK_KEY, value: { type: 'boolean', value: true } }
    : { key: BOOKMARK_KEY, remove: true }))
  return { path, bookmark: on }
}

export const bookmarksFeature = defineFeature({
  name: 'bookmarks',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/bookmarks', async (c) => c.json({ bookmarks: await listBookmarks(ctx) }))

    app.put('/api/bookmarks', async (c) => {
      const raw: unknown = await c.req.json()
      const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const path = typeof body['path'] === 'string' ? body['path'] : null
      if (path === null) return c.json({ error: 'path_required' }, 400)
      return c.json(await setBookmark(ctx, path, body['bookmark'] !== false))
    })
  },

  tools: [
    {
      name: 'list_bookmarks',
      description: 'ブックマーク (frontmatter の bookmark: true) が付いたノートを返す。',
      capability: 'read',
      run: async (ctx) => ({ bookmarks: await listBookmarks(ctx) }),
    },
    {
      name: 'set_bookmark',
      description: 'ノートのブックマークを付け外しする。',
      capability: 'write',
      parameters: {
        path: { type: 'string', description: 'vault 内のノートのパス', required: true },
        bookmark: { type: 'boolean', description: '付けるなら true、外すなら false (既定は true)' },
      },
      run: async (ctx, args) => setBookmark(ctx, String(args['path']), args['bookmark'] !== false),
    },
  ],

  help: [
    {
      name: 'bookmarks',
      body: `# ブックマーク

よく使うノートに ★ を付けます。状態はノート自身の frontmatter に書かれます。

\`\`\`
---
bookmark: true
---
\`\`\`

設定ファイルの一覧ではないので、**ノートと一緒に旅をします**。別の vault に移しても、
\`.loamium\` を消しても残り、他のプロパティと同じように検索やクエリから引けます。

外すときは \`bookmark: false\` を残さず、キーごと消します。

## ツール

- \`list_bookmarks\` — ★ の付いたノート一覧
- \`set_bookmark\` — 付け外し (\`bookmark: false\` で外す)
`,
    },
  ],
})
