import { attachmentName, contentTypeOf, isTextual } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import { ASSETS_DIR, type VaultFile } from './contract'

/**
 * 添付ファイル (task #16)。
 *
 * ノートと同じ vault の中に**普通のファイルとして**置く。参照は `![[assets/図.png]]` で、
 * これは標準の WikiLink 埋め込みそのもの (独自記法なし / Obsidian と同じ慣行)。
 *
 * ⚠️ **`.md` はここから書かせない。** ノートの書き込みは notes 機能の担当で、
 * そちらは `normalizeForSave()` を通る。ここを抜け道にすると正規形が崩れる。
 */

async function listFiles(ctx: Context): Promise<VaultFile[]> {
  return ctx.vault.listFiles()
}

/** 置き場所を決める。フォルダ指定が無ければ assets/ に入れ、名前がぶつかったら連番を足す */
async function targetPath(ctx: Context, requested: string): Promise<string> {
  const clean = requested.replace(/^\/+/, '')
  const slash = clean.lastIndexOf('/')
  const dir = slash === -1 ? ASSETS_DIR : clean.slice(0, slash)
  const name = slash === -1 ? clean : clean.slice(slash + 1)
  const taken = (await listFiles(ctx))
    .filter((f) => f.path.startsWith(`${dir}/`))
    .map((f) => f.path.slice(dir.length + 1))
  return `${dir}/${attachmentName(name, taken)}`
}

export const filesFeature = defineFeature({
  name: 'files',
  inject: ['vault'],

  routes: (app, ctx) => {
    app.get('/api/files', async (c) => c.json({ files: await listFiles(ctx) }))

    app.post('/api/files/:path{.+}', async (c) => {
      const requested = decodeURIComponent(c.req.param('path'))
      if (requested.endsWith('.md')) return c.json({ error: 'md_not_allowed' }, 400)
      const body = new Uint8Array(await c.req.arrayBuffer())
      if (body.byteLength === 0) return c.json({ error: 'empty_body' }, 400)
      const path = await ctx.vault.writeBytes(await targetPath(ctx, requested), body)
      return c.json({ path, size: body.byteLength })
    })

    app.get('/api/files/:path{.+}', async (c) => {
      const path = decodeURIComponent(c.req.param('path'))
      try {
        const bytes = await ctx.vault.readBytes(path)
        // ⚠️ 拡張子から決めた型で配る。分からないものは octet-stream にして
        //    ブラウザに解釈させない (vault の中身は他人が置いたものかもしれない)
        return c.body(bytes as unknown as ArrayBuffer, 200, {
          'content-type': contentTypeOf(path),
          'cache-control': 'no-cache',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1) ?? 'file')}`,
        })
      } catch {
        return c.json({ error: 'not_found' }, 404)
      }
    })
  },

  tools: [
    {
      name: 'list_files',
      description: 'vault にある添付ファイル (.md 以外) を、サイズと更新時刻つきで返す。',
      capability: 'read',
      run: async (ctx) => ({ files: await listFiles(ctx) }),
    },
    {
      name: 'read_file',
      description: 'テキストの添付 (txt / csv / コード) の中身を読む。画像や PDF は読めない。',
      capability: 'read',
      parameters: { path: { type: 'string', description: 'vault 内のファイルパス', required: true } },
      run: async (ctx, args) => {
        const path = String(args['path'])
        if (!isTextual(path)) throw new Error(`テキストとして読めません: ${path}`)
        return { path, content: await ctx.vault.read(path) }
      },
    },
    {
      name: 'delete_file',
      description: '添付ファイルを削除する。ノート (.md) は note_delete を使うこと。',
      capability: 'write',
      parameters: { path: { type: 'string', description: 'vault 内のファイルパス', required: true } },
      run: async (ctx, args) => {
        const path = String(args['path'])
        if (path.endsWith('.md')) throw new Error('ノートの削除は note_delete を使ってください')
        await ctx.vault.remove(path)
        return { path, removed: true }
      },
    },
  ],

  help: [
    {
      name: 'files',
      body: `# 添付ファイル

画像・PDF・CSV などを vault の中に普通のファイルとして置き、ノートからは
\`![[assets/図.png]]\` で参照します。**標準の WikiLink 埋め込みそのもの**で、
独自記法は使いません。

## 置き場所

既定は \`assets/\`。同じ名前があれば \`図-2.png\` のように連番が付きます (黙って上書きしません)。

## 見え方

| 種類 | ノートでの表示 |
| --- | --- |
| 画像 | そのまま表示 |
| PDF | ページを埋め込み表示 |
| CSV / TSV | 表として表示 |
| テキスト / コード | 中身をそのまま表示 |
| その他 | ファイル名とサイズのカード (押すと開く) |

## ツール

- \`list_files\` — 添付の一覧 (サイズ・更新時刻)
- \`read_file\` — テキストの添付を読む
- \`delete_file\` — 添付を消す

⚠️ \`.md\` はこの機能では書けません。ノートの書き込みは \`write_note\` を使ってください
(そちらは保存時に正規形へ揃えます)。
`,
    },
  ],
})
