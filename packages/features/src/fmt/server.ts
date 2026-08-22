import { defineFeature } from '@loamium/server/src/feature'

/**
 * vault 全体を正規形へ揃える。ADR-0035 が前提にしている「初回の正規化コミット」を
 * 実行可能にするための機能。以後 1 文字編集の diff は 1 行で済むようになる。
 */
export const fmtFeature = defineFeature({
  name: 'fmt',
  inject: ['vault'],

  routes: (app, ctx) => {
    app.post('/api/vault/fmt', async (c) => {
      const dryRun = c.req.query('dry-run') === '1' || c.req.query('dryRun') === 'true'
      const result = await ctx.vault.fmt({ dryRun })
      return c.json({ ...result, dryRun })
    })
  },

  tools: [
    {
      name: 'fmt_vault',
      description:
        'vault 内の全 Markdown を標準形へ正規化する。git の diff を安定させるために一度だけ通す。まず dry_run=true で影響範囲を確認すること。',
      capability: 'write',
      parameters: {
        dry_run: { type: 'boolean', description: '書き込まず対象だけ返す', required: false },
      },
      run: (ctx, args) => ctx.vault.fmt({ dryRun: args['dry_run'] === true }),
    },
  ],

  help: [
    {
      name: 'fmt',
      body: `# vault の正規化 (fmt)

Loamium は編集内容をファイルへ書き戻すとき、必ず**標準 Markdown の正規形**へ揃えます。
既存の vault はまだ正規形になっていないため、**最初に一度だけ \`fmt\` を通します**。

\`\`\`sh
loamium fmt --dry-run   # 影響範囲を確認する
loamium fmt             # 実行する
\`\`\`

## なぜ必要か

正規化しないままエディタで 1 文字だけ編集すると、そのファイル全体が書き換わり、
git の diff が巨大になります。先に vault 全体を揃えておけば、**大きな diff は
最初の 1 コミットだけ**で、以後の編集は 1 行の差分で済みます。

## 何が変わるか

リストマーカー・強調記号の統一、テーブルの桁、ブロック間の空行など**書式だけ**です。
意味 (見出し構造・リンク・本文) は変わりません。実行前に git がクリーンな状態か
確認し、\`fmt\` の結果だけを 1 コミットにすることを勧めます。
`,
    },
  ],
})
