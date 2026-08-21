import { defineFeature } from '../feature'

/** エージェント向けの自己記述 API。ツール一覧と help をエージェントが引ける。 */
export const agentFeature = defineFeature({
  name: 'agent',

  routes: (app, ctx) => {
    app.get('/api/agent/tools', (c) => {
      const cap = c.req.query('capability')
      const granted = cap === undefined ? undefined : cap.split(',')
      return c.json({
        tools: ctx.tools.list(granted).map(({ name, description, capability, parameters }) => ({
          name, description, capability, parameters: parameters ?? {},
        })),
      })
    })

    app.get('/api/agent/help', (c) =>
      c.json({ topics: ctx.tools.helpTopics().map((t) => t.name) }))

    app.get('/api/agent/help/:name', (c) => {
      const topic = ctx.tools.help(c.req.param('name'))
      return topic ? c.text(topic.body) : c.json({ error: 'not_found' }, 404)
    })
  },

  tools: [
    {
      name: 'help',
      description:
        'Loamium の機能の使い方を引く。引数なしでトピック一覧、topic 指定で本文を返す。まずこれを読むこと。',
      capability: 'read',
      parameters: { topic: { type: 'string', description: 'トピック名', required: false } },
      run: (ctx, args) => {
        const name = args['topic']
        if (name === undefined || name === null || name === '') {
          return Promise.resolve({ topics: ctx.tools.helpTopics().map((t) => t.name) })
        }
        const topic = ctx.tools.help(String(name))
        return Promise.resolve(
          topic ? { body: topic.body } : { error: `未知のトピック: ${String(name)}` },
        )
      },
    },
  ],

  help: [
    {
      name: 'help',
      body: `# help の引き方

\`help\` を引数なしで呼ぶとトピック一覧が返ります。\`topic\` を指定すると本文 (Markdown) が返ります。

機能ごとの詳しい使い方は base プロンプトではなくこの知識ベースにあります (ADR-0014)。
迷ったらまず \`help\` を引いてください。
`,
    },
  ],
})
