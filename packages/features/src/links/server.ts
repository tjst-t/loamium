import {
  findBacklinksIn, normalizeVaultPath, parseWikiLinks, resolveWikiLink, type Backlink,
} from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'

export interface OutgoingLink {
  /** `[[…]]` に書かれたリンク先 */
  target: string
  heading: string | null
  alias: string | null
  /** 解決できた vault パス。null なら壊れリンク */
  path: string | null
  line: number
}

/** 走査中に消えたファイルで全体を落とさない */
async function readOrNull(ctx: Context, path: string): Promise<string | null> {
  try {
    return await ctx.vault.read(path)
  } catch {
    return null
  }
}

/**
 * バックリンクは**毎回 vault を走査して数える**。検索 (features/search.ts) と同じ方針で、
 * 索引を持たないぶん外部エディタや git・エージェントの書き込み直後でも必ず最新になる。
 */
async function backlinksOf(ctx: Context, target: string): Promise<Backlink[]> {
  const wanted = normalizeVaultPath(target)
  const known = ctx.noteIndex.paths()
  const perFile = await Promise.all(known.map(async (path) => {
    if (path === wanted) return [] // 自分自身へのリンクは出さない
    const content = await readOrNull(ctx, path)
    return content === null ? [] : findBacklinksIn(path, content, wanted, known)
  }))
  return perFile.flat().sort((a, b) => a.path.localeCompare(b.path, 'ja') || a.line - b.line)
}

async function outgoingOf(ctx: Context, from: string): Promise<OutgoingLink[]> {
  const path = normalizeVaultPath(from)
  const content = await ctx.vault.read(path)
  const known = ctx.noteIndex.paths()
  return parseWikiLinks(content).map((link) => ({
    target: link.target,
    heading: link.heading,
    alias: link.alias,
    path: resolveWikiLink(link.target, known, path),
    line: content.slice(0, link.start).split('\n').length,
  }))
}

/** vault 全体の壊れリンク */
async function brokenOf(ctx: Context): Promise<{ from: string; target: string; line: number }[]> {
  const known = ctx.noteIndex.paths()
  const perFile = await Promise.all(known.map(async (path) => {
    const content = await readOrNull(ctx, path)
    if (content === null) return []
    return parseWikiLinks(content)
      .filter((link) => resolveWikiLink(link.target, known, path) === null)
      .map((link) => ({
        from: path,
        target: link.target,
        line: content.slice(0, link.start).split('\n').length,
      }))
  }))
  return perFile.flat()
}

/**
 * WikiLink `[[…]]` の解決・バックリンク・壊れリンク。
 * REST と CLI (`loamium backlinks` / `links` / `broken-links`) が 1:1 で対応する。
 */
export const linksFeature = defineFeature({
  name: 'links',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/backlinks', async (c) => {
      const path = c.req.query('path')
      if (path === undefined || path === '') return c.json({ error: 'path_required' }, 400)
      return c.json({ path: normalizeVaultPath(path), backlinks: await backlinksOf(ctx, path) })
    })

    app.get('/api/links', async (c) => {
      const path = c.req.query('path')
      if (path === undefined || path === '') return c.json({ error: 'path_required' }, 400)
      try {
        return c.json({ path: normalizeVaultPath(path), links: await outgoingOf(ctx, path) })
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'VaultPathError') throw err
        return c.json({ error: 'not_found' }, 404)
      }
    })

    app.get('/api/broken-links', async (c) => c.json({ broken: await brokenOf(ctx) }))
  },

  tools: [
    {
      name: 'list_backlinks',
      description: 'そのノートを [[リンク]] で参照しているノートを、行番号つきで返す。',
      capability: 'read',
      parameters: { path: { type: 'string', description: 'vault 相対パス', required: true } },
      run: async (ctx, args) => ({ backlinks: await backlinksOf(ctx, String(args['path'])) }),
    },
    {
      name: 'list_links',
      description: 'そのノートから出ている [[リンク]] を返す。解決できなければ path が null (壊れリンク)。',
      capability: 'read',
      parameters: { path: { type: 'string', description: 'vault 相対パス', required: true } },
      run: async (ctx, args) => ({ links: await outgoingOf(ctx, String(args['path'])) }),
    },
    {
      name: 'find_broken_links',
      description: 'vault 全体から、行き先の無い [[リンク]] を探す。',
      capability: 'read',
      run: async (ctx) => ({ broken: await brokenOf(ctx) }),
    },
  ],

  help: [
    {
      name: 'links',
      body: `# WikiLink とバックリンク

ノート同士のつながりは \`[[ノート名]]\` で書きます。**標準 Markdown のまま**で、
ブロック ID のような独自記法は一切足しません。

- \`[[ノート名]]\` — ノート名だけ (vault 内で一意ならこれで解決します)
- \`[[フォルダ/ノート名]]\` — 同名のノートが複数あるとき
- \`[[ノート名#見出し]]\` — 見出しを指す
- \`[[ノート名|表示名]]\` — 表示だけ変える

## 解決の規則

1. パスの一致 → ノート名の一致 の順に探します
2. 同名が複数あるときは**リンク元と同じフォルダ**を優先し、次に浅い階層、最後に名前順
3. 大小文字と NFC のゆれ (濁点の合成/分解) は吸収します
4. 見つからなければ**壊れリンク**です (\`find_broken_links\` で一覧できます)

## ツール

- \`list_backlinks\` — そのノートを指しているノート (行番号つき)
- \`list_links\` — そのノートから出ているリンク (\`path: null\` が壊れリンク)
- \`find_broken_links\` — vault 全体の壊れリンク

## リネームしたときは

\`note_move\` でノートを動かすと、**本文中の \`[[リンク]]\` は自動で追従します**
(見出しと表示名は保たれます)。コードフェンスやインラインコードの中の \`[[…]]\` は
リンクではないので書き換えません。
`,
    },
  ],
})
