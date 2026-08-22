import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import type { Root, RootContent, Text, Break } from 'mdast'
import { defaultHandlers, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown'

/**
 * Loamium の Markdown プロセッサ。不変条件 2 (round-trip 差分ゼロ) の実装点。
 *
 * remark-stringify の既定は「正規化」寄りで、そのままだと 1 文字編集しただけで
 * ファイル全体が書き換わり git sync の diff が爆発する。**原文の書き方を保つ**方向へ倒す。
 * 以下 4 点は実測した差分原因への対策 (2026-08-21 / コーパス: 機能ガイド 26 ファイル)。
 */
export const stringifyOptions: ToMarkdownOptions = {
  bullet: '-',
  listItemIndent: 'one',
  emphasis: '_',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  ruleSpaces: false,
  tightDefinitions: true,
  resourceLink: false,
  setext: false,
  incrementListMarker: true,

  // 対策 1: ブロック間の空行数を原文どおりに保つ。
  // 既定は「常に 1 行空ける」なので、`---` の直後に見出しが続く書き方が崩れる。
  // parse 済みツリーは position を持つので、元の行間から空行数を復元する。
  // (エディタが組んだ position 無しのツリーでは undefined = 既定に委ねる)
  join: [
    (left: RootContent, right: RootContent): number | undefined => {
      const end = left.position?.end.line
      const start = right.position?.start.line
      if (end === undefined || start === undefined) return undefined
      return Math.max(0, start - end - 1)
    },
  ],

  handlers: {
    // 対策 2: `[` のエスケープだけを選択的に戻す。
    //
    // 既定は `[` を `\[` に逃がすため `[[WikiLink]]` と callout `> [!tip]` が壊れる。
    // ただし **エスケープを一律で切ってはいけない**: 表セル内の `\|` まで剥がれ、
    // 再パース時に列区切りと解釈されて表が破壊される (実測: Vault同期の使い方.md で
    // 2 列の表が 4 列に化けた)。
    // よって既定のエスケープを通したうえで、`\[` だけを選択的に復元する。
    text: (node: Text, parent, state, info): string => {
      const escaped = defaultHandlers.text(node, parent, state, info)
      // `\[` と `\#` だけを戻す。`\|` `\*` `\_` などの構造的エスケープには触れない。
      //
      // `\#` は **後ろが空白でないときだけ** 戻す。CommonMark の ATX 見出しは
      // `#` の直後に空白 (または行末) が要るので、`#tag` は見出しにならず戻して安全。
      // 逆に `\# 見出し` と `\<行末>` を戻すと本物の見出しに化けるため、そこは触らない。
      // これを怠ると Obsidian 互換のインラインタグ `#tag` が `\#tag` に化ける。
      return escaped.replace(/\\(?=\[)/g, '').replace(/\\#(?=\S)/g, '#')
    },

    // 対策 3: hard break を `\` ではなく行末 2 スペースで出す (原文の書き方)
    break: (_node: Break): string => '  \n',
  },
}

export function createProcessor(): Processor<Root, undefined, undefined, Root, string> {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    // 対策 4: テーブルのセルを桁揃えしない (既定は最長セルに合わせて空白詰め)
    .use(remarkGfm, { singleTilde: false, tablePipeAlign: false, tableCellPadding: true })
    .use(remarkMath)
    .use(remarkStringify, stringifyOptions) as unknown as Processor<
      Root, undefined, undefined, Root, string
    >
}

const processor = createProcessor()

export function parseMarkdown(src: string): Root {
  return processor.parse(src)
}

export function serializeMarkdown(tree: Root): string {
  return processor.stringify(tree)
}

/** parse → serialize。不変条件 2 が成立するなら入力とバイト一致する。 */
export function roundTrip(src: string): string {
  return serializeMarkdown(parseMarkdown(src))
}
