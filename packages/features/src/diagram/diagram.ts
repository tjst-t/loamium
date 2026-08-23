import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

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
let counter = 0

function diagramFor(view: EditorView, code: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'diagram'
  box.contentEditable = 'false'

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
  void loadMermaid()
    .then(async (api) => api.render(`loamium-diagram-${String(counter++)}`, code))
    .then((result) => {
      cache.set(code, result.svg)
      view.dispatch(view.state.tr)
    })
    .catch((cause: unknown) => {
      failed.set(code, cause instanceof Error ? cause.message : '図を描けません')
      view.dispatch(view.state.tr)
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
        // 図は常に添える (書きながら結果が見える)
        decorations.push(Decoration.widget(to, (view) => diagramFor(view, code), {
          side: 1,
          key: `diagram-${String(pos)}-${String(cache.has(code))}-${String(failed.has(code))}`,
          ignoreSelection: true,
        }))
        return false
      })
      return DecorationSet.create(state.doc, decorations)
    },
  },
})

export const diagram = [$prose(() => diagramPlugin)]
