import { Service, type Context } from 'cordis'
import type { AgentTool, HelpTopic } from '../feature'

/**
 * エージェント操作ツールと help 知識ベースのレジストリ。
 * 登録は `defineFeature` 経由でのみ行う (機能とツールが乖離しないようにするため)。
 */
export class ToolsService extends Service {
  static readonly inject = []
  private toolMap = new Map<string, AgentTool>()
  private helpMap = new Map<string, HelpTopic>()
  /** 登録されている機能の名前。UI 側の有効・無効判定に使う (/api/features) */
  private featureNames = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  registerFeature(name: string): void {
    this.featureNames.add(name)
  }

  features(): string[] {
    return [...this.featureNames].sort()
  }

  registerTool(tool: AgentTool): void {
    if (this.toolMap.has(tool.name)) throw new Error(`ツール名が重複しています: ${tool.name}`)
    this.toolMap.set(tool.name, tool)
  }

  registerHelp(topic: HelpTopic): void {
    this.helpMap.set(topic.name, topic)
  }

  /** ケーパビリティで絞ったツール一覧 (ADR-0015)。granted 省略時は全部 */
  list(granted?: readonly string[]): AgentTool[] {
    const all = [...this.toolMap.values()]
    return granted === undefined ? all : all.filter((t) => granted.includes(t.capability))
  }

  get(name: string): AgentTool | undefined {
    return this.toolMap.get(name)
  }

  helpTopics(): HelpTopic[] {
    return [...this.helpMap.values()]
  }

  help(name: string): HelpTopic | undefined {
    return this.helpMap.get(name)
  }

  /** ケーパビリティ検証込みで実行する */
  async invoke(name: string, args: Record<string, unknown>, granted: readonly string[]): Promise<unknown> {
    const tool = this.toolMap.get(name)
    if (!tool) throw new Error(`未知のツール: ${name}`)
    if (!granted.includes(tool.capability)) {
      throw new Error(`ケーパビリティが不足しています: ${tool.capability} が必要です`)
    }
    return tool.run(this.ctx, args)
  }
}
