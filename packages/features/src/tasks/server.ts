import { parseTasks, setTaskChecked, setTaskField } from '@loamium/shared'
import { defineFeature } from '@loamium/server/src/feature'
import type { Context } from 'cordis'
import { parse as parseYaml } from 'yaml'
import { VOCAB_PATH, type TaskItem, type TaskVocab, type VocabItem } from './contract'

/**
 * タスク (task #19 / ADR-0029)。
 *
 * チェックボックスは GFM 標準、状態・優先度・期限は Dataview のインラインフィールド
 * `[key:: value]`。**語彙 (取りうる値) はコードに埋めない** — vault の
 * `system/settings.yaml` に書けて、無ければ既定値を使う。
 */

/** 既定の語彙。設定ファイルが無い vault でもそのまま使える */
const DEFAULT_VOCAB: TaskVocab = {
  status: [
    { key: 'todo', label: '未着手' },
    { key: 'progress', label: '進行中' },
    { key: 'blocked', label: 'ブロック' },
    { key: 'done', label: '完了', done: true },
  ],
  priority: [
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
    { key: 'urgent', label: '緊急' },
  ],
}

function toItems(raw: unknown, fallback: VocabItem[]): VocabItem[] {
  if (!Array.isArray(raw)) return fallback
  const items = raw.flatMap((entry): VocabItem[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const key = typeof record['key'] === 'string' ? record['key'] : null
    if (key === null) return []
    const label = typeof record['label'] === 'string' ? record['label'] : key
    return [record['done'] === true ? { key, label, done: true } : { key, label }]
  })
  return items.length === 0 ? fallback : items
}

async function vocabOf(ctx: Context): Promise<TaskVocab> {
  try {
    const raw: unknown = parseYaml(await ctx.vault.read(VOCAB_PATH))
    const tasks = (raw as { tasks?: Record<string, unknown> } | null)?.tasks
    if (tasks === undefined) return DEFAULT_VOCAB
    return {
      status: toItems(tasks['status'], DEFAULT_VOCAB.status),
      priority: toItems(tasks['priority'], DEFAULT_VOCAB.priority),
    }
  } catch {
    // 設定が無い / 壊れている vault でもタスクは使えるべき
    return DEFAULT_VOCAB
  }
}

async function listTasks(ctx: Context, only?: string): Promise<TaskItem[]> {
  const paths = only === undefined ? ctx.noteIndex.paths() : [only]
  const found = await Promise.all(paths.map(async (path) => {
    try {
      return parseTasks(await ctx.vault.read(path)).map((task) => ({
        path, line: task.line, checked: task.checked, text: task.text, fields: task.fields,
      }))
    } catch {
      return []
    }
  }))
  return found.flat()
}

interface Patch {
  path: string
  line: number
  checked?: boolean
  key?: string
  value?: string | null
}

/**
 * 1 行だけ書き換える。
 *
 * 完了と status は**互いに追従する** (ADR-0029): `done: true` の status を選べば
 * チェックも入り、チェックを外せば status も未完了側に戻る。
 * status を持たないタスクはチェックボックスだけで完結する (何も足さない)。
 */
async function patchTask(ctx: Context, patch: Patch): Promise<{ path: string; line: number }> {
  const vocab = await vocabOf(ctx)
  const content = await ctx.vault.read(patch.path)
  const task = parseTasks(content).find((t) => t.line === patch.line)
  if (task === undefined) throw new Error(`タスクが見つかりません: ${patch.path}:${String(patch.line)}`)

  let next = content
  if (patch.key !== undefined) {
    next = setTaskField(next, patch.line, patch.key, patch.value ?? null)
    if (patch.key === 'status' && patch.value !== undefined && patch.value !== null) {
      const item = vocab.status.find((s) => s.key === patch.value)
      if (item !== undefined) next = setTaskChecked(next, patch.line, item.done === true)
    }
  }
  if (patch.checked !== undefined) {
    next = setTaskChecked(next, patch.line, patch.checked)
    // status を持っているタスクだけ追従させる (持たないものに勝手に足さない)
    if (task.fields['status'] !== undefined) {
      const wanted = patch.checked
        ? vocab.status.find((s) => s.done === true)
        : vocab.status.find((s) => s.done !== true)
      if (wanted !== undefined) next = setTaskField(next, patch.line, 'status', wanted.key)
    }
  }
  await ctx.vault.write(patch.path, next)
  return { path: patch.path, line: patch.line }
}

export const tasksFeature = defineFeature({
  name: 'tasks',
  inject: ['vault', 'noteIndex'],

  routes: (app, ctx) => {
    app.get('/api/tasks/vocab', async (c) => c.json(await vocabOf(ctx)))

    app.get('/api/tasks', async (c) => c.json({ tasks: await listTasks(ctx, c.req.query('path')) }))

    app.patch('/api/tasks', async (c) => {
      const raw: unknown = await c.req.json()
      const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const path = typeof body['path'] === 'string' ? body['path'] : null
      const line = typeof body['line'] === 'number' ? body['line'] : null
      if (path === null || line === null) return c.json({ error: 'path_and_line_required' }, 400)
      const patch: Patch = { path, line }
      if (typeof body['checked'] === 'boolean') patch.checked = body['checked']
      if (typeof body['key'] === 'string') {
        patch.key = body['key']
        patch.value = typeof body['value'] === 'string' ? body['value'] : null
      }
      try {
        return c.json(await patchTask(ctx, patch))
      } catch (error: unknown) {
        // 行番号がずれている (外部から書き換わった) ときは 404。500 にしない
        return c.json({ error: error instanceof Error ? error.message : 'not_a_task' }, 404)
      }
    })
  },

  tools: [
    {
      name: 'list_tasks',
      description: 'vault のタスク (`- [ ]` の行) を返す。path を渡すとそのノートだけ。',
      capability: 'read',
      parameters: { path: { type: 'string', description: 'vault 内のノートのパス (省略すると全部)' } },
      run: async (ctx, args) => {
        const path = typeof args['path'] === 'string' ? args['path'] : undefined
        return { tasks: await listTasks(ctx, path) }
      },
    },
    {
      name: 'task_vocab',
      description: 'タスクの status / priority に使える値 (語彙) を返す。',
      capability: 'read',
      run: async (ctx) => vocabOf(ctx),
    },
    {
      name: 'set_task',
      description: 'タスク 1 行の完了状態やインラインフィールド ([status:: …] など) を書き換える。',
      capability: 'write',
      parameters: {
        path: { type: 'string', description: 'vault 内のノートのパス', required: true },
        line: { type: 'number', description: '0 始まりの行番号 (list_tasks が返す)', required: true },
        checked: { type: 'boolean', description: 'チェックの入り切り' },
        key: { type: 'string', description: 'インラインフィールドの名前 (status / priority / due)' },
        value: { type: 'string', description: '値。省略するとそのフィールドを消す' },
      },
      run: async (ctx, args) => {
        const patch: Patch = { path: String(args['path']), line: Number(args['line']) }
        if (typeof args['checked'] === 'boolean') patch.checked = args['checked']
        if (typeof args['key'] === 'string') {
          patch.key = args['key']
          patch.value = typeof args['value'] === 'string' ? args['value'] : null
        }
        return patchTask(ctx, patch)
      },
    },
  ],

  help: [
    {
      name: 'tasks',
      body: `# タスク

チェックボックスは GFM 標準です。単純なものはこれだけで完結します。

\`\`\`
- [ ] 資料を集める
- [x] 下書きを書く
\`\`\`

## 状態・優先度・期限

必要なときだけ、行末に **Dataview のインラインフィールド** を足します
(ブロック ID も独自記法も使いません)。

\`\`\`
- [ ] レビュー [status:: progress] [priority:: high] [due:: 2026-08-30]
\`\`\`

## 語彙

\`status\` / \`priority\` に使える値は vault の \`system/settings.yaml\` で決められます。
無ければ既定 (status: todo / progress / blocked / done、priority: low / medium / high / urgent)。

\`\`\`yaml
tasks:
  status:
    - key: progress
      label: 進行中
    - key: done
      label: 完了
      done: true
\`\`\`

\`done: true\` の status を付けるとチェックも入り、チェックを外すと status も未完了側に戻ります。
**status を持たないタスクには何も足しません。**

## ツール

- \`list_tasks\` — タスクの一覧 (パス・行番号・フィールド)
- \`task_vocab\` — 使える値
- \`set_task\` — 1 行だけ書き換える (行番号は \`list_tasks\` が返すもの)
`,
    },
  ],
})
