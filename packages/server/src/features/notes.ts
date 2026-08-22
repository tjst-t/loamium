import { defineFeature } from '../feature'

/**
 * ノートのブラウズと基本操作。
 * REST と CLI (`loamium tree` / `ls` / `cat` / `write` / `new` / `mv` / `rm` / `mkdir`) が 1:1 で対応する。
 */
export const notesFeature = defineFeature({
  name: 'notes',
  inject: ['vault', 'noteIndex', 'sse'],

  routes: (app, ctx) => {
    app.get('/api/health', (c) =>
      c.json({ ok: true, notes: ctx.noteIndex.size, sseClients: ctx.sse.clientCount }))

    app.get('/api/notes', (c) => c.json({ paths: ctx.noteIndex.paths() }))

    /** サイドバー用の階層。空フォルダも含む */
    app.get('/api/tree', async (c) => c.json({ tree: await ctx.vault.tree() }))

    // ⚠️ 動詞をパスの末尾に付けない (`/api/notes/foo.md/move`)。`:path{.+}` は貪欲で、
    //    登録順にかかわらず catch-all が先に食う (実測: 動詞付きノートが作られてしまった)。
    //    パスをボディに入れた独立エンドポイントにする。ノートでもフォルダでも同じ入口。
    app.post('/api/move', async (c) => {
      const { from, to } = await c.req.json<{ from?: string; to?: string }>()
      if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
        return c.json({ error: 'from_and_to_required' }, 400)
      }
      return c.json({ ok: true, ...(await ctx.vault.move(from, to)) })
    })

    /** 新規作成。既存があれば 409 (上書きは POST) */
    app.put('/api/notes/:path{.+}', async (c) => {
      const body = c.req.header('content-length') === '0' ? '' : await c.req.text()
      return c.json({ ok: true, path: await ctx.vault.create(c.req.param('path'), body) })
    })

    app.delete('/api/notes/:path{.+}', async (c) =>
      c.json({ ok: true, path: await ctx.vault.remove(c.req.param('path')) }))

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

    app.post('/api/folders/:path{.+}', async (c) =>
      c.json({ ok: true, path: await ctx.vault.createFolder(c.req.param('path')) }))

    /** フォルダは中身ごと消える */
    app.delete('/api/folders/:path{.+}', async (c) =>
      c.json({ ok: true, path: await ctx.vault.remove(c.req.param('path')) }))
  },

  tools: [
    {
      name: 'list_notes',
      description: 'vault 内の Markdown ノートのパス一覧を返す。',
      capability: 'read',
      run: (ctx) => Promise.resolve({ paths: ctx.noteIndex.paths() }),
    },
    {
      name: 'list_tree',
      description: 'vault のフォルダ階層を返す。空フォルダも含む。',
      capability: 'read',
      run: async (ctx) => ({ tree: await ctx.vault.tree() }),
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
      description: 'ノートを書く (既存なら上書き)。内容は保存前に標準 Markdown へ正規化される。',
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
    {
      name: 'note_create',
      description: 'ノートを新規作成する。すでに存在する場合は失敗する (上書きしたいなら write_note)。',
      capability: 'write',
      parameters: {
        path: { type: 'string', description: 'vault 相対パス (.md)', required: true },
        content: { type: 'string', description: 'Markdown 本文。省略時は空' },
      },
      run: async (ctx, args) => ({
        path: await ctx.vault.create(String(args['path']), String(args['content'] ?? '')),
      }),
    },
    {
      name: 'note_move',
      description: 'ノートまたはフォルダをリネーム・移動する。',
      capability: 'write',
      parameters: {
        from: { type: 'string', description: '現在の vault 相対パス', required: true },
        to: { type: 'string', description: '移動先の vault 相対パス', required: true },
      },
      run: (ctx, args) => ctx.vault.move(String(args['from']), String(args['to'])),
    },
    {
      name: 'note_delete',
      description: 'ノートまたはフォルダを削除する。フォルダは中身ごと消える。',
      capability: 'write',
      parameters: { path: { type: 'string', description: 'vault 相対パス', required: true } },
      run: async (ctx, args) => ({ path: await ctx.vault.remove(String(args['path'])) }),
    },
    {
      name: 'folder_create',
      description: 'フォルダを作る。',
      capability: 'write',
      parameters: { path: { type: 'string', description: 'vault 相対パス', required: true } },
      run: async (ctx, args) => ({ path: await ctx.vault.createFolder(String(args['path'])) }),
    },
  ],

  help: [
    {
      name: 'notes',
      body: `# ノートのブラウズと基本操作

vault 内のノートは標準 Markdown ファイルです。パスは vault ルートからの相対パスで指定します。

- \`list_notes\` — ノートのパス一覧 (平坦)
- \`list_tree\` — フォルダ階層 (空フォルダも含む)
- \`read_note\` — 本文を読む
- \`write_note\` — 本文を書く (既存なら上書き)
- \`note_create\` — 新規作成 (既存なら失敗する)
- \`note_move\` — リネーム / 移動 (ノートでもフォルダでも同じ)
- \`note_delete\` — 削除 (フォルダは中身ごと)
- \`folder_create\` — フォルダ作成

## 使い分け

**既存のノートを壊したくないときは \`note_create\` を使ってください。** \`write_note\` は黙って
上書きします。移動とリネームは同じ操作です (\`note_move\` の \`to\` にフォルダを含むパスを渡す)。

## 注意

- \`..\` を含むパスは拒否されます (vault の外には出られません)
- 書き込んだ内容は保存前に**標準 Markdown へ正規化**されます。リストマーカーや
  テーブルの桁が揃うことがありますが、意味は変わりません
- 書き込み・移動・削除は \`.loamium/audit.log\` に記録されます
- 移動しても本文中の \`[[リンク]]\` はまだ追従しません (別途対応予定)
`,
    },
  ],
})
