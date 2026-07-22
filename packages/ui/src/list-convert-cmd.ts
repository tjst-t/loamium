/**
 * リストタイプ変換 (箇条書き ⇄ 番号付き) の CodeMirror コマンド (Story S6848dc-6)。
 *
 * - 変換ロジック本体は `@loamium/shared` の `convertListLines` (DOM 非依存 純関数)。
 *   UI (この Command) とサーバ (エージェント note_convert_list) が同じロジックを共有し、
 *   二重管理を避ける (CLAUDE.md)。
 * - このモジュールは `@codemirror/state` のみ (view/DOM 非依存) を掴む。選択範囲が
 *   触れるリストブロックを CommonMark ネスト規則の単位に上下拡張し、その行群を
 *   `convertListLines` に通して差分だけ dispatch する。
 * - ordered へ変換したときの採番は `convertListLines` 内で `renumberLines` により
 *   ネスト対応で行われる (AC-3)。変換後に outline の renumberListener も追従するが、
 *   変換自体で正しい番号を書く。
 */
import type { Command } from '@codemirror/view';
import { convertListLines, type ListConvertTarget } from '@loamium/shared';

/** 順序 or 箇条書きマーカー行かどうか (行頭空白許容)。 */
function isListMarkerLine(text: string): boolean {
  return /^\s*(?:\d{1,9}[.)]|[-*+])\s+/.test(text);
}

/** リストマーカー行、またはインデントされた継続行かどうか (ブロック拡張用)。 */
function isListOrContinuation(text: string): boolean {
  if (isListMarkerLine(text)) return true;
  return text.length > 0 && /^\s/.test(text) && text.trim().length > 0;
}

/**
 * 指定行 (1 始まり) を含む「連続したリストブロック (継続行 + リスト間の単一空行を含む)」の
 * 先頭・末尾行番号を返す。renumberChangesForRange と同じ境界規則で、ネスト全体を
 * 変換単位に含める。
 */
function listBlockBounds(
  doc: { lines: number; line: (n: number) => { text: string } },
  fromLine: number,
  toLine: number,
): { start: number; end: number } {
  const total = doc.lines;
  let start = Math.max(1, Math.min(fromLine, total));
  let end = Math.max(start, Math.min(toLine, total));

  // 上へ拡張
  while (start > 1) {
    const prev = doc.line(start - 1).text;
    if (isListOrContinuation(prev)) {
      start -= 1;
    } else if (prev.trim().length === 0 && start - 2 >= 1 && isListOrContinuation(doc.line(start - 2).text)) {
      start -= 1;
    } else {
      break;
    }
  }
  // 下へ拡張
  while (end < total) {
    const next = doc.line(end + 1).text;
    if (isListOrContinuation(next)) {
      end += 1;
    } else if (next.trim().length === 0 && end + 2 <= total && isListOrContinuation(doc.line(end + 2).text)) {
      end += 1;
    } else {
      break;
    }
  }
  return { start, end };
}

/**
 * 選択範囲が触れるリストブロックを target へ変換する CodeMirror コマンドを返す。
 *
 * - 選択が (すべて) 非リスト行なら false を返しキーを消費しない。
 * - リスト行があれば、その行を含むリストブロックを CommonMark 単位で上下拡張し、
 *   `convertListLines` で一括変換して差分行のみ dispatch する (AC-1 / AC-4)。
 * - 複数選択レンジにも対応 (各レンジのブロックを収集して重複排除)。
 */
export function makeConvertListCommand(target: ListConvertTarget): Command {
  return (view) => {
    const { state } = view;
    // 選択が触れる各レンジからブロックを集める (重複行は 1 度だけ変換)。
    const blocks: { start: number; end: number }[] = [];
    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toLine = state.doc.lineAt(range.to).number;
      // このレンジがリスト行に一切触れていなければスキップ
      let touchesList = false;
      for (let n = fromLine; n <= toLine; n++) {
        if (isListMarkerLine(state.doc.line(n).text)) {
          touchesList = true;
          break;
        }
      }
      if (!touchesList) continue;
      blocks.push(listBlockBounds(state.doc, fromLine, toLine));
    }
    if (blocks.length === 0) return false; // リスト行なし → キーを消費しない

    // ブロックを昇順にし重なりをマージする (複数レンジが同じブロックを指す場合)。
    blocks.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const b of blocks) {
      const last = merged[merged.length - 1];
      if (last !== undefined && b.start <= last.end + 1) {
        if (b.end > last.end) last.end = b.end;
      } else {
        merged.push({ ...b });
      }
    }

    const changes: { from: number; to: number; insert: string }[] = [];
    for (const { start, end } of merged) {
      const originals: string[] = [];
      const lineObjs: { from: number; to: number }[] = [];
      for (let n = start; n <= end; n++) {
        const l = state.doc.line(n);
        originals.push(l.text);
        lineObjs.push({ from: l.from, to: l.to });
      }
      const convertedLines = convertListLines(originals, target);
      for (let i = 0; i < lineObjs.length; i++) {
        const orig = originals[i];
        const next = convertedLines[i];
        const lo = lineObjs[i];
        if (orig === undefined || next === undefined || lo === undefined) continue;
        if (orig === next) continue;
        changes.push({ from: lo.from, to: lo.to, insert: next });
      }
    }

    // リスト行を処理したのでキーは消費する (変更 0 = 既に目的タイプでも true)。
    if (changes.length === 0) return true;
    view.dispatch({
      changes,
      userEvent: target === 'ordered' ? 'input.convert-ordered' : 'input.convert-bullet',
    });
    return true;
  };
}

/** 選択リストを箇条書きに変換する Command (Ctrl+Shift+8 / パレット)。 */
export const convertListToBullet: Command = makeConvertListCommand('bullet');

/** 選択リストを番号付きに変換する Command (Ctrl+Shift+7 / パレット)。 */
export const convertListToOrdered: Command = makeConvertListCommand('ordered');
