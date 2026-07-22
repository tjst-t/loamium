/**
 * 順序リスト採番の CodeMirror 連携 (Story S6848dc-5)。
 *
 * 設計方針 (重要 — 二重管理の排除):
 * - 採番の**中核 純関数** (`renumberLines` / `renumberOrderedLists`) と
 *   リストタイプ変換 (`convertListLines` / `convertListMarkdown`) は `@loamium/shared`
 *   (`list-convert.ts`) へ集約した。UI とサーバ (エージェント) が同じロジックを共有
 *   するため。ここでは shared の採番純関数を **re-export** し、既存の import
 *   (`list-renumber.test.ts` / `outline.ts`) を壊さない。
 * - このモジュールに残すのは `@codemirror/state` (EditorState / Text / ChangeSpec)
 *   に依存する `renumberChangesForRange` のみ。`@codemirror/view` (DOM 依存) は
 *   import しない (root vitest は node 環境なので DOM を掴むと落ちる)。
 */
import type { EditorState, ChangeSpec, Line } from '@codemirror/state';
import { renumberLines } from '@loamium/shared';

// 採番・変換の中核純関数は shared に集約。互換のため re-export する。
export { renumberLines, renumberOrderedLists } from '@loamium/shared';

/**
 * EditorState の行範囲 [fromLine, toLine] を内包する「順序リストのまとまり」を
 * 再採番するための ChangeSpec 群を返す。DOM には触れない (EditorState は state
 * パッケージ = DOM 非依存)。`outline.ts` の Tab / Shift+Tab / Enter 適用後に
 * 呼び出して、影響ブロックを整合させる。
 *
 * 影響範囲は指定行を含む「連続したリスト行 (+ 継続行/空行) のブロック」を上下に
 * 拡張して決定する。ブロック単位で renumberLines に通し、行が変わった箇所だけ
 * ChangeSpec を作る (変わらない行はスキップして無駄な変更を出さない)。
 *
 * @param state    現在の EditorState
 * @param fromLine 影響開始行番号 (1 始まり)
 * @param toLine   影響終了行番号 (1 始まり, 含む)
 * @returns 番号が変わった行だけの ChangeSpec 配列 (空なら変更不要)
 */
export function renumberChangesForRange(
  state: EditorState,
  fromLine: number,
  toLine: number,
): ChangeSpec[] {
  const doc = state.doc;
  const total = doc.lines;
  const clampedFrom = Math.max(1, Math.min(fromLine, total));
  const clampedTo = Math.max(clampedFrom, Math.min(toLine, total));

  // ブロック境界を上下へ拡張する。リスト行または「直前がリスト行の空行」を含める。
  const blockStart = expandBlockUp(doc, clampedFrom);
  const blockEnd = expandBlockDown(doc, clampedTo);

  const originals: string[] = [];
  const lineObjs: Line[] = [];
  for (let n = blockStart; n <= blockEnd; n++) {
    const l = doc.line(n);
    originals.push(l.text);
    lineObjs.push(l);
  }

  const renumbered = renumberLines(originals);
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < lineObjs.length; i++) {
    const orig = originals[i];
    const next = renumbered[i];
    const lineObj = lineObjs[i];
    if (orig === undefined || next === undefined || lineObj === undefined) continue;
    if (orig === next) continue;
    changes.push({ from: lineObj.from, to: lineObj.to, insert: next });
  }
  return changes;
}

/** 指定行から上に、リストブロックの先頭行番号を探す。 */
function expandBlockUp(doc: EditorState['doc'], startLine: number): number {
  let n = startLine;
  while (n > 1) {
    const prev = doc.line(n - 1);
    if (isListOrContinuation(prev.text)) {
      n -= 1;
    } else if (prev.text.trim().length === 0 && n - 2 >= 1 && isListOrContinuation(doc.line(n - 2).text)) {
      // リスト行同士の間の単一空行は跨いで拡張する
      n -= 1;
    } else {
      break;
    }
  }
  return n;
}

/** 指定行から下に、リストブロックの末尾行番号を探す。 */
function expandBlockDown(doc: EditorState['doc'], startLine: number): number {
  const total = doc.lines;
  let n = startLine;
  while (n < total) {
    const next = doc.line(n + 1);
    if (isListOrContinuation(next.text)) {
      n += 1;
    } else if (next.text.trim().length === 0 && n + 2 <= total && isListOrContinuation(doc.line(n + 2).text)) {
      n += 1;
    } else {
      break;
    }
  }
  return n;
}

/** リストマーカー行、またはインデントされた継続行かどうか。 */
function isListOrContinuation(text: string): boolean {
  // 順序 or 箇条書きマーカー行
  if (/^\s*(?:\d{1,9}[.)]|[-*+])\s+/.test(text)) return true;
  // 空でなく先頭が空白 (インデント) の行は継続行の可能性がある
  return text.length > 0 && /^\s/.test(text) && text.trim().length > 0;
}
