import type { Root, RootContent, Parent } from 'mdast'
import { parseMarkdown, serializeMarkdown } from './processor'

/** `<br />` だけを含む html ノードか (前後の空白は許容する) */
function isBareBreak(node: RootContent): boolean {
  return node.type === 'html' && /^\s*<br\s*\/?>\s*$/i.test(node.value)
}

function hasChildren(node: unknown): node is Parent {
  return typeof node === 'object' && node !== null && Array.isArray((node as Parent).children)
}

/**
 * エディタ由来のツリーを、ファイルへ書く前に整える。
 *
 * Milkdown は空のテーブルセルを編集可能に保つため `<br />` を差し込む。
 * これは書式の揺れではなく **内容の混入** で、そのまま書くとピュア Markdown に
 * HTML が残り、他エディタで開いたときにも見えてしまう (不変条件 1 の趣旨に反する)。
 * それ単体でコンテナを占めている `<br />` は落とす (空セル・空リスト項目の両方)。
 */
function stripEditorArtifacts(node: unknown): void {
  if (!hasChildren(node)) return
  // 中身が `<br />` だけのコンテナは、Milkdown が空欄を編集可能に保つために
  // 差し込んだプレースホルダ。空のテーブルセルと空のリスト項目の両方で出る。
  // 「全部の子が bare な <br />」のときだけ落とす (本文中の <br /> は残す)。
  if (node.children.length > 0 && node.children.every((c) => isBareBreak(c as RootContent))) {
    node.children = [] as unknown as typeof node.children
  }
  // ⚠️ **ブロックの位置に 1 つだけ落ちている `<br />` も落とす。** 埋め込みを消して
  //    段落が空になると、Milkdown はそこへ `<br />` を置く。上の「全部が br」条件では
  //    兄弟がいるぶん引っかからず、ファイルに HTML が残っていた (実機で発生)
  const blockish = new Set(['root', 'blockquote', 'listItem', 'tableCell', 'footnoteDefinition'])
  if (blockish.has((node as { type?: string }).type ?? '')) {
    const kept: RootContent[] = []
    let dropped = false
    for (const c of node.children as RootContent[]) {
      const isJunk = isBareBreak(c) || (c.type === 'paragraph' && c.children.length === 0)
      if (isJunk) { dropped = true; continue }
      // ⚠️ **消した直後のノードは position を落とす。** serializer は原文の空行数を
      //    position から復元する (`join`) ので、消したノードのぶんの空行がそのまま
      //    残ってしまう (実機で空行が 2 行に増えた)
      if (dropped) { delete c.position; dropped = false }
      kept.push(c)
    }
    node.children = kept as typeof node.children
  }
  for (const child of node.children) stripEditorArtifacts(child)
}

/**
 * 保存経路の正規化。**ファイルへ書き戻す経路は必ずここを通す。**
 *
 * エディタ (Milkdown) とサーバー/CLI (shared) は serializer が別物なので、
 * 素のままだと正規形が食い違い、片方が書く → もう片方が書き直す、で
 * git の diff が永久に振動する。両者の出口をこの関数に一本化して収束させる。
 */
export function normalizeForSave(markdown: string): string {
  const tree: Root = parseMarkdown(markdown)
  stripEditorArtifacts(tree)
  return serializeMarkdown(tree)
}
