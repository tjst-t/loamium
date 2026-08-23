import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { isAttachment, parseWikiLinks } from '@loamium/shared'
import { apiJson } from '@loamium/ui/src/api'
import { getEditorEnv } from '@loamium/ui/src/editor/editor-env'
import { embedApi, type EmbedResult } from './contract'

/**
 * 埋め込み `![[ノート#見出し]]` の表示 (task #13)。
 *
 * **スキーマは触らない。** 本文では `![[…]]` はテキストのまま置き、その下に中身のカードを
 * widget decoration で差し込む。編集しているのは常に `![[…]]` という文字列なので、
 * serializer にも round-trip にも影響しない。
 *
 * 中身は**読むためのもの**なので編集できない (直したいなら元のノートを開く)。
 */
interface Found {
  from: number
  to: number
  target: string
}

function embedsIn(state: EditorState): Found[] {
  const out: Found[] = []
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || node.text === null || node.text === undefined) return true
    if (parent?.type.spec.code === true) return false
    // ⚠️ インラインコードの中は「書き方の説明」。ここを拾うと、ガイドに書いた
    //    `![[assets/図.png]]` の例までプレビューされる (実機で二重に出た)
    if (node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === 'inlineCode')) return true
    for (const link of parseWikiLinks(node.text)) {
      // 添付 (画像・PDF など) は files 機能が描く。ここで触ると二重になる
      if (!link.embed || isAttachment(link.target)) continue
      const target = link.heading === null || link.heading === ''
        ? link.target
        : `${link.target}#${link.heading}`
      out.push({ from: pos + link.start, to: pos + link.end, target })
    }
    return true
  })
  return out
}

/** 取ってきた中身。キーは「どのノートから見た target か」 */
const cache = new Map<string, EmbedResult>()
const pending = new Set<string>()

const cacheKey = (from: string, target: string): string => `${from} ${target}`

function cardFor(view: EditorView, target: string): HTMLElement {
  const env = getEditorEnv()
  const key = cacheKey(env.currentPath, target)
  const card = document.createElement('div')
  card.className = 'embed-card'
  card.contentEditable = 'false'

  const found = cache.get(key)
  if (found === undefined) {
    card.classList.add('is-loading')
    card.textContent = '読み込んでいます…'
    if (!pending.has(key)) {
      pending.add(key)
      apiJson<EmbedResult>(embedApi.resolve(target, env.currentPath))
        .then((result) => {
          cache.set(key, result)
          pending.delete(key)
          // 取れたら描き直す (空の transaction で decoration を貼り直す)
          view.dispatch(view.state.tr)
        })
        .catch(() => { pending.delete(key) })
    }
    return card
  }

  if (found.path === null) {
    card.classList.add('is-broken')
    card.textContent = `${target} — まだ無いノート`
    return card
  }

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'embed-head'
  head.textContent = found.heading === null || found.heading === ''
    ? found.path
    : `${found.path} / ${found.heading}`
  head.addEventListener('mousedown', (event) => {
    event.preventDefault()
    if (found.path !== null) env.open(found.path)
  })

  const body = document.createElement('div')
  body.className = 'embed-body'
  body.textContent = found.excerpt === '' ? '(空のノート)' : found.excerpt
  if (found.truncated) body.classList.add('is-truncated')

  card.append(head, body)
  return card
}

const embedPlugin = new Plugin({
  key: new PluginKey('loamium-embed'),
  props: {
    decorations(state) {
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      for (const found of embedsIn(state)) {
        decorations.push(Decoration.inline(found.from, found.to, {
          class: 'embed-source',
          'data-target': found.target,
        }))
        // 段落が埋め込みだけなら、隠れたテキストのぶんの空行を詰める
        const $pos = state.doc.resolve(found.from)
        const parent = $pos.parent
        if (parent.textContent.trim() === state.doc.textBetween(found.from, found.to)) {
          decorations.push(Decoration.node($pos.before(), $pos.after(), { class: 'is-embed-only' }))
        }
        // カードは**常に**出す。埋め込みだけの行にカーソルが来ただけで中身が消えると、
        // 「ノートの先頭に埋め込みを置く」よくある書き方で何も見えなくなる
        // ⚠️ key に読み込み状態を含める。同じ key の widget は DOM が再利用され、
        //    中身が届いても「読み込んでいます…」のまま止まる (実機で発生)
        const loaded = cache.has(cacheKey(getEditorEnv().currentPath, found.target))
        decorations.push(Decoration.widget(found.to, (view) => cardFor(view, found.target), {
          side: 1,
          key: `embed-${found.target}-${loaded ? 'ready' : 'loading'}`,
          ignoreSelection: true,
        }))
        // 記法そのものは、カーソルが**中に入っている**ときだけ見せる
        if (selFrom > found.from && selTo < found.to) continue
        decorations.push(Decoration.inline(found.from, found.to, { class: 'embed-syntax' }))
      }
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

/** テスト用: 取得済みの中身を差し込む */
export function primeEmbed(currentPath: string, target: string, result: EmbedResult): void {
  cache.set(cacheKey(currentPath, target), result)
}

export const embed = [$prose(() => embedPlugin)]
