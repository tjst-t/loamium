import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { attachActions } from '@loamium/ui/src/editor/block-actions'
import { copyAsImage, paperColor } from '@loamium/ui/src/editor/copy-image'
import { copyText } from '@loamium/ui/src/editor/clipboard'

/**
 * Mermaid 図 (task #14)。
 *
 * ` ```mermaid ` のコードフェンスを図として描く。**フェンスはそのまま残す** —
 * 図は表示であって、ファイルに書かれるのはいつも Mermaid のテキスト (不変条件 1)。
 *
 * ⚠️ Mermaid は重い (bundle で数百 KB)。**図があるノートを開いたときだけ**動的に読み込む。
 */
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}

let mermaid: MermaidApi | null = null
let loading: Promise<MermaidApi> | null = null

export async function loadMermaid(): Promise<MermaidApi> {
  if (mermaid !== null) return mermaid
  loading ??= import('mermaid').then((module) => {
    const api = (module.default ?? module) as unknown as MermaidApi
    api.initialize({
      startOnLoad: false,
      // 画面の配色に寄せる (外から持ってきたテーマは浮く)
      theme: 'base',
      fontFamily: getComputedStyle(document.body).getPropertyValue('--sans') || 'sans-serif',
      themeVariables: {
        primaryColor: readVar('--panel', '#f4f5f7'),
        primaryTextColor: readVar('--ink', '#14171a'),
        primaryBorderColor: readVar('--rule-strong', '#c5cad0'),
        lineColor: readVar('--ink-3', '#848b94'),
        secondaryColor: readVar('--panel-2', '#e8eaed'),
        tertiaryColor: readVar('--paper', '#ffffff'),
      },
    })
    mermaid = api
    return api
  })
  return loading
}

function readVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** 描いた SVG。同じ図を何度も描き直さない */
const cache = new Map<string, string>()
const failed = new Map<string, string>()
/** 描画中のもの。打鍵のたびに同じ図を何本も描き始めないようにする */
const pending = new Set<string>()
let counter = 0

/**
 * ⚠️ **編集の入口が要る。** フェンスは畳んであるので、図から入れないと直す手段が無くなる。
 * ただし**押しただけで編集に入れない** — ホバー/タップで操作バーを出す。
 */
function diagramFor(view: EditorView, code: string, editPos: number): HTMLElement {
  const box = document.createElement('div')
  box.className = 'diagram'
  box.contentEditable = 'false'
  attachActions(box, [
    {
      label: '編集',
      run: () => {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(editPos))))
        view.focus()
        return false
      },
    },
    { label: '画像をコピー', run: async () => copyAsImage(box, paperColor()) },
    { label: 'テキストをコピー', run: async () => copyText(code) },
  ])

  const svg = cache.get(code)
  if (svg !== undefined) {
    box.innerHTML = svg
    return box
  }
  const error = failed.get(code)
  if (error !== undefined) {
    box.classList.add('is-broken')
    box.textContent = error
    return box
  }

  box.classList.add('is-loading')
  box.textContent = '図を描いています…'
  if (pending.has(code)) return box
  pending.add(code)
  void loadMermaid()
    .then(async (api) => api.render(`loamium-diagram-${String(counter++)}`, code))
    .then((result) => {
      cache.set(code, result.svg)
    })
    .catch((cause: unknown) => {
      failed.set(code, cause instanceof Error ? cause.message : '図を描けません')
    })
    .finally(() => {
      pending.delete(code)
      // ⚠️ 描画中にエディタが畳まれることがある (ノート切り替え・アンマウント)。
      //    破棄済みの view に dispatch すると Milkdown の ctx が無く例外になる
      if (!view.isDestroyed) view.dispatch(view.state.tr)
    })
  return box
}

/** テスト用: 描画結果を差し込む */
export function primeDiagram(code: string, svg: string): void {
  cache.set(code, svg)
}

/** そのノードが Mermaid のフェンスか */
export function isMermaidFence(node: { type: { spec: { code?: boolean } }; attrs: Record<string, unknown> }): boolean {
  return node.type.spec.code === true && String(node.attrs['language'] ?? '').toLowerCase() === 'mermaid'
}

const diagramPlugin = new Plugin({
  key: new PluginKey('loamium-diagram'),
  props: {
    decorations(state: EditorState) {
      const { from: selFrom, to: selTo } = state.selection
      const decorations: Decoration[] = []
      state.doc.descendants((node, pos) => {
        if (!isMermaidFence(node)) return true
        const to = pos + node.nodeSize
        const code = node.textContent.trim()
        if (code === '') return false
        // 中にカーソルがあるときは、フェンスの中身を書き換えている最中
        const editing = selFrom > pos && selTo < to
        decorations.push(Decoration.node(pos, to, {
          class: `mermaid-source ${editing ? 'is-editing' : 'is-rendered'}`,
        }))
        // 図は常に添える (書きながら結果が見える)。
        // キャレットはフェンスの**末尾**に入れる (続きを書き足す場所)。
        // ⚠️ **key には図の中身と描画状態の両方を入れる** (実機で 2 回踏んだ):
        //    中身が無い → 書き換えても key が同じで DOM が再利用され、新しい図が描かれない
        //    状態が無い → 描き終わっても key が同じで「描いています…」のまま止まる
        const phase = cache.has(code) ? 'ready' : failed.has(code) ? 'broken' : 'loading'
        decorations.push(Decoration.widget(to, (view) => diagramFor(view, code, to - 1), {
          side: 1,
          key: `diagram-${String(pos)}-${phase}-${code}`,
          ignoreSelection: true,
        }))
        return false
      })
      return DecorationSet.create(state.doc, decorations)
    },

  },
})

export const diagram = [$prose(() => diagramPlugin)]
