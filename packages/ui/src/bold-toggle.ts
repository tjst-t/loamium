/**
 * Ctrl-B / Cmd-B で選択テキストの Bold をトグルする CodeMirror コマンド (S2e8a4c-6)。
 *
 * - 選択あり + 既に ** で囲まれている → UnBold (** を除去)
 * - 選択あり + 未囲み → Bold (**で囲む)
 * - 選択なし (カーソルのみ) → **** を挿入してカーソルを内側に移動
 *
 * ピュア Markdown のみ書き込む (DESIGN_PRINCIPLES priority 1)。
 */
import type { Command } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

/** 文字列が ** で始まり ** で終わるか (最小 5 文字: **x**) */
export function isBoldText(text: string): boolean {
  return text.startsWith('**') && text.endsWith('**') && text.length >= 5;
}

export interface BoldToggleResult {
  /** 変換後のドキュメント文字列 */
  doc: string;
  /** 変換後の選択範囲 [anchor, head] */
  selection: [number, number];
}

/**
 * ドキュメント文字列と選択範囲 [anchor, head] を受け取り、
 * Bold トグル後の結果を返す純粋関数 (ユニットテスト用)。
 */
export function applyBoldToggle(doc: string, anchor: number, head: number): BoldToggleResult {
  if (anchor === head) {
    // 選択なし: **** を挿入してカーソルを内側に
    const newDoc = doc.slice(0, anchor) + '****' + doc.slice(anchor);
    return { doc: newDoc, selection: [anchor + 2, anchor + 2] };
  }
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const text = doc.slice(from, to);
  if (isBoldText(text)) {
    // UnBold: ** を除去
    const inner = text.slice(2, -2);
    const newDoc = doc.slice(0, from) + inner + doc.slice(to);
    return { doc: newDoc, selection: [from, from + inner.length] };
  }
  // Bold: ** で囲む
  const newDoc = doc.slice(0, from) + `**${text}**` + doc.slice(to);
  return { doc: newDoc, selection: [from, from + text.length + 4] };
}

export const toggleBold: Command = (view) => {
  const { state } = view;
  const { selection } = state;
  const changes: { from: number; to: number; insert: string }[] = [];
  const newRanges: { anchor: number; head: number }[] = [];

  for (const range of selection.ranges) {
    if (range.empty) {
      // 選択なし: **** を挿入してカーソルを内側に
      const pos = range.from;
      changes.push({ from: pos, to: pos, insert: '****' });
      newRanges.push({ anchor: pos + 2, head: pos + 2 });
    } else {
      const from = Math.min(range.anchor, range.head);
      const to = Math.max(range.anchor, range.head);
      const text = state.sliceDoc(from, to);
      if (isBoldText(text)) {
        // UnBold: ** を除去
        const inner = text.slice(2, -2);
        changes.push({ from, to, insert: inner });
        newRanges.push({ anchor: from, head: from + inner.length });
      } else {
        // Bold: ** で囲む
        changes.push({ from, to, insert: `**${text}**` });
        newRanges.push({ anchor: from, head: from + text.length + 4 });
      }
    }
  }

  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    selection: EditorSelection.create(
      newRanges.map((r) => EditorSelection.range(r.anchor, r.head)),
    ),
    userEvent: 'input',
  });
  return true;
};
