import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { createSuggest } from '@loamium/ui/src/editor/suggest'

/**
 * 絵文字の補完 (task #52)。
 *
 * **入るのは絵文字そのもの** (`:tada:` のようなショートコードではない)。
 * ファイルが正本なので、他のエディタで開いてもそのまま絵文字として読める形にする。
 *
 * ⚠️ トリガは**半角の `:` だけ**。日本語入力中は全角 `：` になるので、そのときは出ない
 * (英数入力に切り替えたときだけ出る、という素直な挙動にする)。
 */
export interface Emoji {
  char: string
  /** 代表的な名前 (一覧に出す) */
  name: string
  /** 探すときの手がかり */
  keywords: string[]
}

/** よく使うものの日本語読み。英語名しか持たないデータを補う */
const JA_ALIASES: Record<string, string[]> = {
  '🎉': ['おめでとう', 'かんぱい', 'いわい'],
  '✅': ['かんりょう', 'できた', 'ちぇっく'],
  '❌': ['ばつ', 'だめ', 'えらー'],
  '⚠️': ['ちゅうい', 'けいこく'],
  '🔥': ['ひ', 'あつい', 'もえる'],
  '💡': ['あいでぃあ', 'ひらめき'],
  '📝': ['めも', 'きろく', 'かく'],
  '📌': ['ぴん', 'とめる'],
  '🚀': ['ろけっと', 'りりーす', 'はやい'],
  '🐛': ['ばぐ', 'むし'],
  '🙏': ['おねがい', 'ありがとう'],
  '👍': ['いいね', 'ぐっど', 'さんせい'],
  '😀': ['えがお', 'わらう'],
  '😢': ['なく', 'かなしい'],
  '🤔': ['かんがえる', 'うーん'],
  '⏰': ['じかん', 'とけい', 'あらーむ'],
  '📅': ['かれんだー', 'ひづけ', 'よてい'],
  '🔗': ['りんく', 'つなぐ'],
  '⭐': ['ほし', 'すたー', 'おきにいり'],
  '💬': ['こめんと', 'はつげん'],
}

let cache: Emoji[] | null = null
let loading: Promise<Emoji[]> | null = null

/**
 * 絵文字データ (1,900 件 / gzip 約 47KB) は**使うときまで読み込まない**。
 * エディタが立ち上がったあと、暇なときに裏で取りに行く。
 */
export async function loadEmoji(): Promise<Emoji[]> {
  if (cache !== null) return cache
  loading ??= import('emojilib').then((module) => {
    const table = (module.default ?? module) as unknown as Record<string, string[]>
    cache = Object.entries(table).map(([char, keywords]) => ({
      char,
      name: (keywords[0] ?? '').replace(/_/g, ' '),
      keywords: [...keywords, ...(JA_ALIASES[char] ?? [])],
    }))
    return cache
  })
  return loading
}

/** テスト用 */
export function primeEmoji(list: Emoji[]): void {
  cache = list
}

const MAX = 12

/**
 * 並べ方: 名前そのもの → 名前の前方一致 → 手がかりの一致 → 部分一致。
 * ⚠️ 単純な「どれかのキーワードに含まれる」だと、`rocket` で 🧑‍🚀 (astronaut) が先に来る。
 */
function rank(emoji: Emoji, needle: string): number {
  const name = emoji.name.toLowerCase()
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  const keywords = emoji.keywords.map((keyword) => keyword.toLowerCase())
  if (keywords.includes(needle)) return 2
  if (keywords.some((keyword) => keyword.startsWith(needle))) return 3
  if (name.includes(needle) || keywords.some((keyword) => keyword.includes(needle))) return 4
  return -1
}

export function searchEmoji(query: string, list: readonly Emoji[]): Emoji[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return list.slice(0, MAX)
  const hits: { emoji: Emoji; score: number; at: number }[] = []
  for (const [at, emoji] of list.entries()) {
    const score = rank(emoji, needle)
    if (score >= 0) hits.push({ emoji, score, at })
  }
  return hits
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, MAX)
    .map((hit) => hit.emoji)
}

/**
 * カーソルの直前が書きかけの `:…` なら、その範囲を返す。
 *
 * - 半角の `:` のみ (全角 `：` は日本語入力中なので出さない)
 * - 行頭か空白の直後だけ (`12:30` や `http://` では出さない)
 * - 続きは英数字と `_` `+` `-` だけ (絵文字の名前は ASCII)
 */
function activeQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  if ($from.parent.type.spec.code === true) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const match = /(?:^|\s):([a-zA-Z0-9_+-]*)$/.exec(before)
  if (match === null) return null
  const query = match[1] ?? ''
  return { from: $from.pos - query.length, to: $from.pos, query }
}

const insert = (char: string): Command => (state, dispatch) => {
  dispatch?.(state.tr.insertText(char).scrollIntoView())
  return true
}

export const emojiSuggest = createSuggest({
  name: 'loamium-emoji',
  priority: 40,
  header: (query) => (query === '' ? '絵文字' : `絵文字: ${query}`),
  match: activeQuery,
  items: (query) => searchEmoji(query, cache ?? []).map((emoji) => ({
    title: `${emoji.char}  ${emoji.name}`,
    subtitle: `:${emoji.keywords[0] ?? ''}:`,
    value: emoji.char,
    run: insert(emoji.char),
  })),
  // `:` と入力を消してから絵文字を置く。直前の空白は残す (文章の区切りなので)
  trigger: { length: 1 },
})

/** エディタが立ち上がったら、暇なときにデータを取りに行く */
const preload = new Plugin({
  key: new PluginKey('loamium-emoji-preload'),
  view: () => {
    const timer = window.setTimeout(() => { void loadEmoji() }, 0)
    return { destroy: () => { window.clearTimeout(timer) } }
  },
})

export const emoji = [$prose(() => emojiSuggest), $prose(() => preload)]
