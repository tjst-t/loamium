import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-diff'

/**
 * コードフェンスの色付け (task #14)。
 *
 * **スキーマも serializer も触らない。** コードはテキストのまま置き、字句だけを
 * decoration で塗る。テーマ CSS は読み込まず、このアプリの配色 (インクとアクセント) に
 * 合わせて自分で色を当てる — 外から持ってきた配色は画面から浮くため。
 */

/** 言語名のゆれを吸収する (Markdown に書かれる名前 → Prism の文法名) */
const ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml', py: 'python', rs: 'rust', md: 'markdown',
  html: 'markup', xml: 'markup', svg: 'markup',
}

export function grammarFor(language: string): Prism.Grammar | null {
  const name = ALIASES[language.toLowerCase()] ?? language.toLowerCase()
  return Prism.languages[name] ?? null
}

export interface Token {
  /** コード先頭からの位置 */
  start: number
  end: number
  /** Prism の字句の種類 (keyword / string / comment …) */
  type: string
}

/** Prism の入れ子トークンを、位置つきの平らな配列にする */
export function tokenize(code: string, language: string): Token[] {
  const grammar = grammarFor(language)
  if (grammar === null) return []
  const out: Token[] = []
  let at = 0
  const walk = (tokens: (string | Prism.Token)[]): void => {
    for (const token of tokens) {
      if (typeof token === 'string') {
        at += token.length
        continue
      }
      const start = at
      if (typeof token.content === 'string') at += token.content.length
      else if (Array.isArray(token.content)) walk(token.content)
      else at += String(token.content).length
      out.push({ start, end: at, type: token.type })
    }
  }
  walk(Prism.tokenize(code, grammar))
  return out
}

function decorationsFor(state: EditorState): Decoration[] {
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.spec.code !== true || !node.isTextblock) return true
    const language = String(node.attrs['language'] ?? '')
    if (language === '') return true
    for (const token of tokenize(node.textContent, language)) {
      decorations.push(Decoration.inline(
        pos + 1 + token.start,
        pos + 1 + token.end,
        { class: `tok tok-${token.type}` },
      ))
    }
    return true
  })
  return decorations
}

const codePlugin = new Plugin({
  key: new PluginKey('loamium-code'),
  props: {
    decorations: (state) => DecorationSet.create(state.doc, decorationsFor(state)),
  },
})

export const code = [$prose(() => codePlugin)]
