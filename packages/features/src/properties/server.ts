import {
  applyPropertyEdit, countPropertyKeys, readProperties,
  type PropertyEdit, type PropertyType,
} from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import type { PropertyKeyCount } from './contract'

/**
 * frontmatter のプロパティ (task #17)。
 *
 * 書き換えは**必ず 1 キーずつ**。ノート全体を受け取って上書きする API にすると、
 * 古い画面が持っていた frontmatter でまるごと巻き戻る (外部エディタ・エージェントが
 * 同じファイルを触る前提なので、この巻き戻りは実際に起きる)。
 */

async function readAll(ctx: Context): Promise<{ path: string; content: string }[]> {
  const paths = ctx.noteIndex.paths()
  const notes = await Promise.all(paths.map(async (path) => {
    try {
      return { path, content: await ctx.vault.read(path) }
    } catch {
      return null
    }
  }))
  return notes.filter((n): n is { path: string; content: string } => n !== null)
}

async function keysOfVault(ctx: Context): Promise<PropertyKeyCount[]> {
  return countPropertyKeys(await readAll(ctx))
}

async function edit(ctx: Context, path: string, change: PropertyEdit): Promise<{ path: string }> {
  const content = await ctx.vault.read(path)
  await ctx.vault.write(path, applyPropertyEdit(content, change))
  return { path }
}

const TYPES: PropertyType[] = ['text', 'number', 'date', 'boolean', 'list', 'tags']
const asType = (value: unknown): PropertyType => {
  const found = TYPES.find((t) => t === value)
  return found ?? 'text'
}

export const propertiesFeature = defineFeature({
  name: 'properties',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/properties/keys', async (c) => c.json({ keys: await keysOfVault(ctx) }))

    app.get('/api/properties', async (c) => {
      const path = c.req.query('path')
      if (path === undefined) return c.json({ error: 'path_required' }, 400)
      const content = await ctx.vault.read(path)
      return c.json({ path, properties: readProperties(content) })
    })

    app.put('/api/properties', async (c) => {
      const raw: unknown = await c.req.json()
      if (typeof raw !== 'object' || raw === null) return c.json({ error: 'invalid_body' }, 400)
      const body = raw as Record<string, unknown>
      const path = typeof body['path'] === 'string' ? body['path'] : null
      const key = typeof body['key'] === 'string' ? body['key'] : null
      if (path === null || key === null) return c.json({ error: 'path_and_key_required' }, 400)
      const change: PropertyEdit = { key }
      if (body['remove'] === true) change.remove = true
      if (typeof body['renameTo'] === 'string') change.renameTo = body['renameTo']
      if ('value' in body) {
        change.value = { type: asType(body['type']), value: body['value'] as never }
      }
      return c.json(await edit(ctx, path, change))
    })
  },

  tools: [
    {
      name: 'list_property_keys',
      description: 'vault の frontmatter で使われているプロパティのキーを、使用数つきで返す。',
      capability: 'read',
      run: async (ctx) => ({ keys: await keysOfVault(ctx) }),
    },
    {
      name: 'get_properties',
      description: 'ノートの frontmatter プロパティを型つきで返す。',
      capability: 'read',
      parameters: { path: { type: 'string', description: 'vault 内のノートのパス', required: true } },
      run: async (ctx, args) => ({ properties: readProperties(await ctx.vault.read(String(args['path']))) }),
    },
    {
      name: 'set_property',
      description: 'ノートの frontmatter のプロパティを 1 つ設定する (無ければ frontmatter ごと作る)。',
      capability: 'write',
      parameters: {
        path: { type: 'string', description: 'vault 内のノートのパス', required: true },
        key: { type: 'string', description: 'プロパティ名', required: true },
        value: { type: 'string', description: '値。list / tags はカンマ区切り', required: true },
        type: { type: 'string', description: 'text | number | date | boolean | list | tags' },
      },
      run: async (ctx, args) => edit(ctx, String(args['path']), {
        key: String(args['key']),
        value: { type: asType(args['type']), value: String(args['value']) },
      }),
    },
    {
      name: 'remove_property',
      description: 'ノートの frontmatter からプロパティを 1 つ消す。',
      capability: 'write',
      parameters: {
        path: { type: 'string', description: 'vault 内のノートのパス', required: true },
        key: { type: 'string', description: 'プロパティ名', required: true },
      },
      run: async (ctx, args) => edit(ctx, String(args['path']), { key: String(args['key']), remove: true }),
    },
  ],

  help: [
    {
      name: 'properties',
      body: `# プロパティ (frontmatter)

ノート先頭の \`---\` で挟んだ YAML が**プロパティ**です。標準の frontmatter そのもので、
独自記法はありません。エディタの中ではなく、右の情報パネルで型つきで編集します。

\`\`\`
---
title: 走り書き
created: 2026-08-23
done: false
tags:
  - 仕事
---
\`\`\`

## 型

| 型 | 例 |
| --- | --- |
| text | \`title: 走り書き\` |
| number | \`count: 3\` |
| date | \`created: 2026-08-23\` |
| boolean | \`done: false\` |
| list | \`links: [a, b]\` |
| tags | \`tags: [仕事]\` (キー名が \`tags\` なら自動でこの型) |

## ツール

- \`list_property_keys\` — vault で使われているキー (使用数つき)
- \`get_properties\` — そのノートのプロパティ
- \`set_property\` / \`remove_property\` — 1 キーずつ書き換える

⚠️ 書き換えは**必ず 1 キーずつ**行われます。ノート全体を上書きしないので、
別の書き手が同時に足したプロパティを巻き戻しません。コメントや並び順もそのまま残ります。
`,
    },
  ],
})
