import type { Context } from 'cordis'
import type { Hono } from 'hono'

/** エージェントに公開するツール。監査済みサービス層 (ctx 経由) だけを呼ぶこと (ADR-0016) */
export interface AgentTool {
  name: string
  description: string
  /** 実行に必要なケーパビリティ (ADR-0015)。読み取り専用なら 'read' */
  capability: string
  /** JSON Schema 相当の簡易記述。引数なしなら省略 */
  parameters?: Record<string, { type: string; description: string; required?: boolean }>
  run: (ctx: Context, args: Record<string, unknown>) => Promise<unknown>
}

/** help 知識ベースの 1 トピック。使い方の詳細は base プロンプトでなくここへ (ADR-0014) */
export interface HelpTopic {
  name: string
  /** ピュア Markdown で書く */
  body: string
}

export interface Feature {
  /** 機能名。help トピック名やログに使う */
  name: string
  /** REST ルート。CLI と 1:1 対応させること */
  routes?: (app: Hono, ctx: Context) => void
  /** エージェント操作ツール。**routes があるなら必須** */
  tools?: AgentTool[]
  /** help トピック。**routes があるなら必須** */
  help?: HelpTopic[]
  /** この機能が使うサービス。http / tools は自動で足される */
  inject?: string[]
}

export class FeatureContractError extends Error {
  override readonly name = 'FeatureContractError'
}

/**
 * 1 機能 = 1 プラグイン。
 *
 * REST ルート・エージェントツール・help トピックを**同じ場所で同時に登録**させる。
 * CLAUDE.md の「新機能にはエージェントツールも必ず実装」を、規約 (人間の努力) ではなく
 * **構造で担保する**ためのチョークポイント。ここを通さずにルートを生やさないこと。
 */
export function defineFeature(feature: Feature): (ctx: Context) => void {
  if (feature.routes) {
    if (!feature.tools?.length) {
      throw new FeatureContractError(
        `feature "${feature.name}": REST ルートを持つ機能にはエージェントツールが必須です (CLAUDE.md / ADR-0016)`,
      )
    }
    if (!feature.help?.length) {
      throw new FeatureContractError(
        `feature "${feature.name}": REST ルートを持つ機能には help トピックが必須です (ADR-0014)`,
      )
    }
  }

  const plugin = (ctx: Context): void => {
    if (feature.routes) ctx.http.mount((app) => feature.routes?.(app, ctx))
    for (const tool of feature.tools ?? []) ctx.tools.registerTool(tool)
    for (const topic of feature.help ?? []) ctx.tools.registerHelp(topic)
    ctx.logger('feature').info(
      'registered: %s (tools=%d, help=%d)',
      feature.name,
      feature.tools?.length ?? 0,
      feature.help?.length ?? 0,
    )
  }
  // 生成順序は inject が解決する (「TDZ 回避」のようなコメントで守らない)
  Object.assign(plugin, { inject: ['http', 'tools', ...(feature.inject ?? [])] })
  // Function.name への **代入** は ESM strict mode で TypeError になるが、
  // defineProperty は configurable なので通る
  Object.defineProperty(plugin, 'name', { value: feature.name })
  return plugin
}
