import { Editor, rootCtx, parserCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { applyLoamiumStringifyOptions } from './markdown-config'
import { exitNodeKeymap } from './exit-node'
import { outline } from './outline'
import { wikilink } from './wikilink'
import { tag } from './tag'

/**
 * Editor.tsx と**同一の構成**で Milkdown を組み、parser / serializer だけを取り出す。
 *
 * round-trip gate をエディタ実体に対しても回すために必要。
 * shared のプロセッサだけを検証しても、Milkdown 独自のスキーマ制約
 * (未対応ノードの落とし方など) で差が出る可能性を潰せないため。
 *
 * 構成を Editor.tsx と揃えておくことがこのハーネスの前提。
 * プリセットやプラグインを Editor.tsx 側で足したら、ここにも足す。
 */
export interface MilkdownTransform {
  parse: (markdown: string) => ProseNode
  serialize: (doc: ProseNode) => string
  destroy: () => Promise<void>
}

export async function createMilkdownTransform(root: HTMLElement): Promise<MilkdownTransform> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      applyLoamiumStringifyOptions(ctx)
    })
    .use(wikilink)
    .use(tag)
    .use(commonmark)
    .use(gfm)
    .use(exitNodeKeymap)
    .use(outline)
    .create()

  let parse!: (markdown: string) => ProseNode
  let serialize!: (doc: ProseNode) => string
  editor.action((ctx) => {
    const parser = ctx.get(parserCtx)
    const serializer = ctx.get(serializerCtx)
    const view = ctx.get(editorViewCtx)
    parse = (markdown: string): ProseNode => {
      const doc = parser(markdown)
      if (!doc) throw new Error('milkdown parser returned null')
      return doc
    }
    serialize = (doc: ProseNode): string => serializer(doc)
    void view
  })

  return { parse, serialize, destroy: async () => { await editor.destroy() } }
}
