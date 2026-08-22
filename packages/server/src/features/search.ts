import { noteHasTag, normalizeVaultPath, rankHits, searchNote, type SearchHit } from '@loamium/shared'
import { defineFeature } from '../feature'
import type { Context } from 'cordis'

/** 1 回の検索で返す最大件数。UI のパレットが扱える量に抑える */
const DEFAULT_LIMIT = 50

export interface SearchOptions {
  query: string
  limit: number
  /** このフォルダ配下だけ (vault 相対) */
  folder?: string | undefined
  /** このタグが付いたノートだけ。親タグは子タグにも一致する */
  tag?: string | undefined
}

/**
 * vault 全体を走査して検索する。
 *
 * **本文をキャッシュせず、毎回ファイルから読む。** インデックスは使い捨てという原則を
 * 保てるうえ、外部エディタや git で書き換えられた直後でも結果がずれない。個人用 vault の
 * 規模では十分速い (大規模 vault 向けの索引化は別途)。
 *
 * 検索語が空でも、フォルダ・タグの絞り込みがあれば「その条件のノート一覧」を返す
 * (詳細検索ページはタグだけで絞ることがある)。
 */
async function runSearch(
  ctx: Context, options: SearchOptions,
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const query = options.query.trim()
  const folder = options.folder === undefined || options.folder === ''
    ? null
    : `${normalizeVaultPath(options.folder)}/`
  const tag = options.tag === undefined || options.tag === '' ? null : options.tag
  if (query === '' && folder === null && tag === null) return { hits: [], truncated: false }

  const paths = ctx.noteIndex.paths().filter((path) => folder === null || path.startsWith(folder))
  const perFile = await Promise.all(paths.map(async (path) => {
    try {
      const content = await ctx.vault.read(path)
      if (tag !== null && !noteHasTag(content, tag)) return []
      // 検索語が無いときは「条件に合うノート」をノート名のヒットとして 1 件返す
      if (query === '') {
        const name = path.slice(path.lastIndexOf('/') + 1)
        return [{ path, line: 0, snippet: name, match: { start: 0, length: 0 }, kind: 'title' } as SearchHit]
      }
      return searchNote(path, content, query)
    } catch {
      // 走査中に消えたファイルで検索全体を落とさない
      return []
    }
  }))

  const ranked = rankHits(perFile.flat())
  return { hits: ranked.slice(0, options.limit), truncated: ranked.length > options.limit }
}

/**
 * 全文検索。ノート名と本文を横断し、行番号つきで返す。
 * REST と CLI (`loamium search`) が 1:1 で対応する。
 */
export const searchFeature = defineFeature({
  name: 'search',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/search', async (c) => {
      const query = c.req.query('q') ?? ''
      const limit = Number(c.req.query('limit') ?? DEFAULT_LIMIT)
      const result = await runSearch(ctx, {
        query,
        limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
        folder: c.req.query('folder'),
        tag: c.req.query('tag'),
      })
      return c.json({ query, ...result })
    })
  },

  tools: [
    {
      name: 'search',
      description:
        'ノート名と本文を横断して全文検索する。行番号つきで返るので、そのまま read_note で開ける。',
      capability: 'read',
      parameters: {
        query: { type: 'string', description: '検索語。大小文字は区別しない。空でも folder / tag で絞れる' },
        folder: { type: 'string', description: 'このフォルダ配下だけに絞る (vault 相対)' },
        tag: { type: 'string', description: 'このタグが付いたノートだけに絞る。親タグは子タグにも一致する' },
        limit: { type: 'number', description: `最大件数 (既定 ${DEFAULT_LIMIT})` },
      },
      run: async (ctx, args) => {
        const limit = Number(args['limit'] ?? DEFAULT_LIMIT)
        return runSearch(ctx, {
          query: String(args['query'] ?? ''),
          limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
          folder: args['folder'] === undefined ? undefined : String(args['folder']),
          tag: args['tag'] === undefined ? undefined : String(args['tag']),
        })
      },
    },
  ],

  help: [
    {
      name: 'search',
      body: `# 全文検索

\`search\` はノート名と本文の両方を対象に、**部分一致**で探します。

- 大小文字は区別しません
- 全角半角・濁点のゆれは NFC 正規化で吸収されます
- ファイル名の一致 (\`kind: "title"\`) が本文の一致より上に来ます
- 本文の一致は**行ごと**に返るので、\`line\` でその行を特定できます

## 結果の読み方

\`\`\`json
{ "path": "projects/loamium.md", "line": 12, "snippet": "…監査ログに記録する…",
  "match": { "start": 1, "length": 4 }, "kind": "body" }
\`\`\`

\`snippet\` は該当行を前後で切り詰めたものです。全文が要るときは \`read_note\` を使ってください。

## 注意

検索は**毎回ファイルを読み直します**。外部エディタや git で変更された直後でも
結果は最新です。ヒットが多いときは \`truncated: true\` が付きます。

## 絞り込み

\`folder\` (vault 相対パス) と \`tag\` で絞れます。\`query\` を空にして \`tag\` だけ渡すと、
そのタグが付いたノートの一覧になります (\`tags\` トピックも参照)。
`,
    },
  ],
})
