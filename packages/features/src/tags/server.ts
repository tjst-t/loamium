import { collectTags, countTags, noteHasTag, normalizeTag, type TagCount } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'

/**
 * タグも**毎回 vault を走査して数える** (検索・バックリンクと同じ方針)。
 * 索引を持たないぶん、外部エディタ・git・エージェントの書き込み直後でも必ず最新になる。
 */
async function readAll(ctx: Context): Promise<{ path: string; content: string }[]> {
  const paths = ctx.noteIndex.paths()
  const notes = await Promise.all(paths.map(async (path) => {
    try {
      return { path, content: await ctx.vault.read(path) }
    } catch {
      return null // 走査中に消えたファイルで全体を落とさない
    }
  }))
  return notes.filter((note): note is { path: string; content: string } => note !== null)
}

async function allTags(ctx: Context): Promise<TagCount[]> {
  return countTags(await readAll(ctx))
}

/** そのタグが付いたノート。親タグは子タグにも一致する */
async function notesWithTag(ctx: Context, tag: string): Promise<{ path: string; tags: string[] }[]> {
  return (await readAll(ctx))
    .filter((note) => noteHasTag(note.content, tag))
    .map((note) => ({ path: note.path, tags: collectTags(note.content) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'ja'))
}

/**
 * タグの一覧と絞り込み。
 * REST と CLI (`loamium tags` / `tag <name>`) が 1:1 で対応する。
 */
export const tagsFeature = defineFeature({
  name: 'tags',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/tags', async (c) => c.json({ tags: await allTags(ctx) }))

    app.get('/api/tags/notes', async (c) => {
      const tag = c.req.query('tag')
      if (tag === undefined || normalizeTag(tag) === '') return c.json({ error: 'tag_required' }, 400)
      return c.json({ tag: normalizeTag(tag), notes: await notesWithTag(ctx, tag) })
    })
  },

  tools: [
    {
      name: 'list_tags',
      description: 'vault で使われているタグを件数つきで返す (多い順)。',
      capability: 'read',
      run: async (ctx) => ({ tags: await allTags(ctx) }),
    },
    {
      name: 'notes_by_tag',
      description: 'そのタグが付いたノートを返す。親タグを指定すると子タグ (#親/子) のノートも含む。',
      capability: 'read',
      parameters: { tag: { type: 'string', description: 'タグ名 (# は付けても付けなくてもよい)', required: true } },
      run: async (ctx, args) => ({ notes: await notesWithTag(ctx, String(args['tag'])) }),
    },
  ],

  help: [
    {
      name: 'tags',
      body: `# タグ

タグは本文中の \`#タグ\` と frontmatter の \`tags:\` の両方から集めます。**標準 Markdown のまま**です。

- \`#仕事\` — 本文中のインラインタグ
- \`#読書/SF\` — \`/\` で入れ子にできる。\`#読書\` で絞ると子タグも含まれる
- \`tags: [仕事, 読書]\` — frontmatter (配列 / カンマ区切り / ブロックシーケンス)

## タグにならないもの

- \`# 見出し\` (空白がある)
- \`https://example.com/#section\` (URL のフラグメント)
- \`#1\` のような数字だけのもの
- コードフェンス・インラインコードの中

## ツール

- \`list_tags\` — 使われているタグと件数 (多い順)
- \`notes_by_tag\` — そのタグが付いたノート一覧

検索 (\`search\`) にも \`tag\` / \`folder\` の絞り込みがあります。タグだけで絞りたいときは
\`query\` を空にして \`tag\` を渡してください。
`,
    },
  ],
})
