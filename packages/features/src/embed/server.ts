import { extractSection, normalizeVaultPath, resolveWikiLink } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import type { EmbedResult } from './contract'

/** 埋め込みで見せる最大の長さ。全文を配らない (読ませたいなら開けばよい) */
const MAX = 1200

/**
 * 埋め込み `![[ノート#見出し]]` の中身を返す (task #13)。
 *
 * 解決規則はリンクと同じものを使う (`resolveWikiLink`)。**節の切り出しは行単位** —
 * 見せるためだけの機能で、正本のファイルには一切触れない。
 */
async function resolveEmbed(ctx: Context, target: string, from: string): Promise<EmbedResult> {
  const [name = '', heading = null] = target.split('#') as [string, string | undefined]
  const path = resolveWikiLink(name, ctx.noteIndex.paths(), from === '' ? undefined : normalizeVaultPath(from))
  if (path === null) return { path: null, heading, excerpt: '', truncated: false }

  const content = await ctx.vault.read(path)
  const body = heading === null || heading === ''
    ? content
    : extractSection(content, heading)?.body ?? ''
  const trimmed = body.trim()
  return {
    path,
    heading: heading === undefined ? null : heading,
    excerpt: trimmed.slice(0, MAX),
    truncated: trimmed.length > MAX,
  }
}

export const embedFeature = defineFeature({
  name: 'embed',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/embed', async (c) => {
      const target = c.req.query('target')
      if (target === undefined || target === '') return c.json({ error: 'target_required' }, 400)
      return c.json(await resolveEmbed(ctx, target, c.req.query('from') ?? ''))
    })
  },

  tools: [
    {
      name: 'read_embed',
      description: '`![[ノート#見出し]]` が指している中身を読む。見出しを指していればその節だけ返す。',
      capability: 'read',
      parameters: {
        target: { type: 'string', description: '`![[…]]` の中身 (例: ノート名#見出し)', required: true },
        from: { type: 'string', description: '書かれているノートの vault 相対パス (同名の解決に使う)' },
      },
      run: async (ctx, args) => resolveEmbed(ctx, String(args['target']), String(args['from'] ?? '')),
    },
  ],

  help: [
    {
      name: 'embed',
      body: `# 埋め込み (transclusion)

\`![[ノート名]]\` と書くと、そのノートの中身をその場に表示します。
\`![[ノート名#見出し]]\` なら、その見出しの節だけを表示します。

- **正本は埋め込み元のファイル**です。埋め込み先を編集しても元は変わりません
- 解決の規則は \`[[リンク]]\` と同じです (\`links\` トピック参照)
- 長い節は途中まで表示します (全文が要るなら \`read_note\`)

\`read_embed\` で、エージェントからも同じ解決規則で中身を読めます。
`,
    },
  ],
})
