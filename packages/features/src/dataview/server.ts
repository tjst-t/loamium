import { parseQuery, runQuery, QueryError, type QueryNote } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import type { QueryResponse } from './contract'

/**
 * dataview 風クエリ (task #20 / ADR-0001)。
 *
 * **索引を持たず毎回 vault を走査する** (検索・タグ・バックリンクと同じ方針)。
 * 外部エディタやエージェントが書いた直後でも結果が最新になる。
 */

async function notesOf(ctx: Context): Promise<QueryNote[]> {
  const paths = ctx.noteIndex.paths()
  const notes = await Promise.all(paths.map(async (path): Promise<QueryNote | null> => {
    try {
      const mtime = await ctx.vault.mtime(path)
      const note: QueryNote = { path, content: await ctx.vault.read(path) }
      return mtime === undefined ? note : { ...note, mtime }
    } catch {
      return null // 走査中に消えたファイルで全体を落とさない
    }
  }))
  return notes.filter((note): note is QueryNote => note !== null)
}

async function run(ctx: Context, source: string): Promise<QueryResponse> {
  try {
    return { result: runQuery(parseQuery(source), await notesOf(ctx)) }
  } catch (error: unknown) {
    if (error instanceof QueryError) return { error: error.message }
    throw error
  }
}

export const dataviewFeature = defineFeature({
  name: 'dataview',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.post('/api/query', async (c) => {
      const raw: unknown = await c.req.json()
      const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const source = typeof body['query'] === 'string' ? body['query'] : null
      if (source === null) return c.json({ error: 'query_required' }, 400)
      return c.json(await run(ctx, source))
    })
  },

  tools: [
    {
      name: 'run_query',
      description: 'dataview 風クエリ (LIST / TABLE / TASK + FROM / WHERE / SORT / LIMIT) を走らせる。',
      capability: 'read',
      parameters: {
        query: { type: 'string', description: 'クエリ本文 (例: LIST FROM #仕事 WHERE status = "進行中")', required: true },
      },
      run: async (ctx, args) => run(ctx, String(args['query'])),
    },
  ],

  help: [
    {
      name: 'dataview',
      body: `# クエリ (dataview)

言語名を \`dataview\` にしたコードフェンスを書くと、その場に結果が出ます。
**ファイルに残るのはクエリ文字列だけ**で、結果は書き戻しません。

\`\`\`
LIST FROM #仕事 WHERE status = "進行中" SORT file.mtime DESC LIMIT 10
\`\`\`

## 書ける形

| 部分 | 書き方 |
| --- | --- |
| 種類 | \`LIST\` / \`TABLE 列, 列\` / \`TASK\` |
| FROM | \`#タグ\` (子タグも含む) / \`"フォルダ"\`。\`and\` / \`or\` でつなげる |
| WHERE | \`=\` \`!=\` \`>\` \`<\` \`>=\` \`<=\` \`contains\`、\`and\` でつなげる。値を書かなければ「持っているか」、\`!\` で否定 |
| SORT | \`フィールド ASC|DESC\` |
| LIMIT | 件数 |

フィールドは frontmatter のキーと、\`file.name\` / \`file.path\` / \`file.folder\` /
\`file.mtime\` / \`file.tags\` / \`file.link\`。TASK では \`text\` / \`completed\` と
インラインフィールド (\`status\` / \`priority\` / \`due\`) も引けます。

## ツール

- \`run_query\` — 同じクエリをそのまま走らせて結果を返す
`,
    },
  ],
})
