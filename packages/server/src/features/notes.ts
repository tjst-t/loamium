import { defineFeature } from '../feature'

/** ノートの読み書き。REST と CLI (`loamium ls` / `cat` / `write`) が 1:1 で対応する。 */
export const notesFeature = defineFeature({
  name: 'notes',
  inject: ['vault', 'noteIndex', 'sse'],

  routes: (app, ctx) => {
    app.get('/api/health', (c) =>
      c.json({ ok: true, notes: ctx.noteIndex.size, sseClients: ctx.sse.clientCount }))

    app.get('/api/notes', (c) => c.json({ paths: ctx.noteIndex.paths() }))

    app.get('/api/notes/:path{.+}', async (c) => {
      try {
        return c.text(await ctx.vault.read(c.req.param('path')))
      } catch (err: unknown) {
        // VaultPathError は onError が 400 にする。ここは純粋な not found のみ
        if (err instanceof Error && err.name === 'VaultPathError') throw err
        return c.json({ error: 'not_found' }, 404)
      }
    })

    app.post('/api/notes/:path{.+}', async (c) => {
      const path = c.req.param('path')
      await ctx.vault.write(path, await c.req.text())
      return c.json({ ok: true, path })
    })
  },

  tools: [
    {
      name: 'list_notes',
      description: 'vault 内の Markdown ノートのパス一覧を返す。',
      capability: 'read',
      run: (ctx) => Promise.resolve({ paths: ctx.noteIndex.paths() }),
    },
    {
      name: 'read_note',
      description: 'ノートの本文を読む。パスは vault 相対。',
      capability: 'read',
      parameters: { path: { type: 'string', description: 'vault 相対パス', required: true } },
      run: async (ctx, args) => ({ content: await ctx.vault.read(String(args['path'])) }),
    },
    {
      name: 'write_note',
      description: 'ノートを書く。内容は保存前に標準 Markdown へ正規化される。',
      capability: 'write',
      parameters: {
        path: { type: 'string', description: 'vault 相対パス', required: true },
        content: { type: 'string', description: 'Markdown 本文', required: true },
      },
      run: async (ctx, args) => {
        await ctx.vault.write(String(args['path']), String(args['content']))
        return { ok: true }
      },
    },
  ],

  help: [
    {
      name: 'notes',
      body: `# ノートの読み書き

vault 内のノートは標準 Markdown ファイルです。パスは vault ルートからの相対パスで指定します。

- \`list_notes\` — ノートのパス一覧
- \`read_note\` — 本文を読む
- \`write_note\` — 本文を書く

## 注意

- \`..\` を含むパスは拒否されます (vault の外には出られません)
- 書き込んだ内容は保存前に**標準 Markdown へ正規化**されます。リストマーカーや
  テーブルの桁が揃うことがありますが、意味は変わりません
- 書き込みは \`.loamium/audit.log\` に記録されます
`,
    },
  ],
})
