import { journalInitialContent, journalPath, resolveJournalDate } from '@loamium/shared'
import { defineFeature } from '../feature'
import type { Context } from 'cordis'

/** 空でない本文の末尾に追記する。段落として離れるよう空行を 1 つ挟む */
function appendText(current: string, text: string): string {
  const body = current.replace(/\s+$/, '')
  return body === '' ? `${text}\n` : `${body}\n\n${text}\n`
}

/**
 * ジャーナルを取得する。**無ければその場で作る (遅延生成)。**
 * 「今日のページを開く」がワークフローの起点なので、開いた時点で存在させる。
 */
async function openJournal(
  ctx: Context, date: string,
): Promise<{ date: string; path: string; content: string; created: boolean }> {
  const path = journalPath(date)
  if (await ctx.vault.exists(path)) {
    return { date, path, content: await ctx.vault.read(path), created: false }
  }
  const content = journalInitialContent(date)
  await ctx.vault.write(path, content)
  // normalizeForSave を通った後の実体を返す (UI が二重に正規化しないように)
  return { date, path, content: await ctx.vault.read(path), created: true }
}

/**
 * デイリージャーナル。`journals/YYYY-MM-DD.md` が正本で、独自の索引は持たない。
 * REST と CLI (`loamium journal` / `journal-append`) が 1:1 で対応する。
 */
export const journalFeature = defineFeature({
  name: 'journal',
  inject: ['vault'],

  routes: (app, ctx) => {
    app.get('/api/journal', async (c) => c.json(await openJournal(ctx, resolveJournalDate(c.req.query('date')))))

    app.post('/api/journal/append', async (c) => {
      const { text, date } = await c.req.json<{ text?: string; date?: string }>()
      if (typeof text !== 'string' || text.trim() === '') return c.json({ error: 'text_required' }, 400)
      const resolved = resolveJournalDate(date)
      const journal = await openJournal(ctx, resolved)
      await ctx.vault.write(journal.path, appendText(journal.content, text))
      return c.json({ ok: true, date: resolved, path: journal.path })
    })
  },

  tools: [
    {
      name: 'journal_read',
      description:
        'デイリージャーナルを読む。date は today / yesterday / +3d / YYYY-MM-DD。**存在しない日は作らずに空を返す**。',
      capability: 'read',
      parameters: { date: { type: 'string', description: '日付。省略時は今日' } },
      run: async (ctx, args) => {
        const date = resolveJournalDate(args['date'] === undefined ? undefined : String(args['date']))
        const path = journalPath(date)
        const exists = await ctx.vault.exists(path)
        return { date, path, exists, content: exists ? await ctx.vault.read(path) : '' }
      },
    },
    {
      name: 'journal_append',
      description:
        'デイリージャーナルの末尾に追記する。無ければ作る。作業ログを残す最重要の入口。',
      capability: 'write',
      parameters: {
        text: { type: 'string', description: '追記する Markdown', required: true },
        date: { type: 'string', description: '日付。省略時は今日' },
      },
      run: async (ctx, args) => {
        const date = resolveJournalDate(args['date'] === undefined ? undefined : String(args['date']))
        const journal = await openJournal(ctx, date)
        await ctx.vault.write(journal.path, appendText(journal.content, String(args['text'])))
        return { date, path: journal.path }
      },
    },
  ],

  help: [
    {
      name: 'journal',
      body: `# デイリージャーナル

1 日 1 ファイルの作業ログです。実体は \`journals/YYYY-MM-DD.md\` という
**ただの Markdown ファイル**で、専用のデータベースはありません。

- \`journal_read\` — 読む (存在しない日は作らず空を返す)
- \`journal_append\` — 末尾に追記する (無ければ作る)

## 日付の指定

\`today\` / \`yesterday\` / \`tomorrow\` / \`+3d\` / \`-1d\` / \`2026-08-22\` を受け付けます。
省略すると今日です。**日付は端末のローカル日付**で解釈されます。

## 使い方の指針

「これをジャーナルにメモして」と頼まれたら \`journal_append\` を使ってください。
追記は既存の本文の末尾に空行を 1 つ挟んで足されるので、既存の記述は消えません。
箇条書き 1 行 (\`- 決めたこと: ...\`) の粒度が扱いやすいです。
`,
    },
  ],
})
