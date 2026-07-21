/**
 * 順序リスト (1. / 1)) のネスト採番を CommonMark 規則で再計算する純関数群。
 * (Story S6848dc-5)
 *
 * 設計方針 (重要):
 * - このモジュールは **DOM 非依存**。`@codemirror/state` (EditorState / Text /
 *   ChangeSpec の型) だけを使い、`@codemirror/view` (EditorView / Decoration =
 *   DOM 依存) は import しない。root vitest は node 環境で動くため、view/DOM を
 *   import する `outline.ts` を直接読むとテストが落ちる。ここに採番ロジックを
 *   切り出すことで node 環境で決定的にユニットテストできる。
 * - 正本はピュア Markdown 文字列 1 本。ブロック ID・独自記法は一切書き込まない。
 *   書き換えるのは順序リストマーカーの **番号** (`1` → `2` 等) のみ。デリミタ
 *   (`.` か `)`) と先頭インデント幅・マーカー後の空白はそのまま保持する。
 * - 階層判定は **先頭空白 (インデント量)** で行う (CommonMark のネスト規則)。
 *   ある行が直前の順序リスト項目より深くインデントされていれば子。浅ければ
 *   祖先のいずれかの兄弟。各階層で兄弟を 1 から連番、子リストは 1 から再開する。
 * - 箇条書き (`-` / `*` / `+`) 行は触らない (番号を持たないため)。ただし階層計算
 *   の文脈としては尊重する (箇条書きの下にネストした順序リストは 1 から始まる)。
 *
 * #3 / #6 はこの純関数 (`renumberOrderedLists`) を再利用する。
 */
import type { EditorState, ChangeSpec, Line } from '@codemirror/state';

/** 行頭空白 + 順序リストマーカー (数字 + `.`|`)` + 1 つ以上の空白) を捉える正規表現。 */
const ORDERED_ITEM_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;

/** 行頭空白 + 箇条書きマーカー (`-`|`*`|`+` + 1 つ以上の空白) を捉える正規表現。 */
const BULLET_ITEM_RE = /^(\s*)([-*+])(\s+)(.*)$/;

/** 解析済みリスト行 (順序リスト or 箇条書き)。 */
interface ParsedListLine {
  /** 元の行文字列 */
  readonly raw: string;
  /** 先頭インデント幅 (空白文字数) */
  readonly indent: number;
  /** 順序リストなら数字部分・デリミタ、箇条書きなら null */
  readonly ordered: { readonly delim: '.' | ')'; readonly markerPad: string } | null;
  /** マーカー(記号)後のコンテンツ開始位置 (indent + marker + pad の文字数) — 子判定に使う */
  readonly contentCol: number;
}

/** 1 行を解析する。リスト行でなければ null。 */
function parseListLine(raw: string): ParsedListLine | null {
  const om = ORDERED_ITEM_RE.exec(raw);
  if (om !== null) {
    const indent = (om[1] ?? '').length;
    const num = om[2] ?? '';
    const delim = (om[3] ?? '.') as '.' | ')';
    const pad = om[4] ?? ' ';
    return {
      raw,
      indent,
      ordered: { delim, markerPad: pad },
      contentCol: indent + num.length + 1 + pad.length,
    };
  }
  const bm = BULLET_ITEM_RE.exec(raw);
  if (bm !== null) {
    const indent = (bm[1] ?? '').length;
    const marker = bm[2] ?? '-';
    const pad = bm[3] ?? ' ';
    return {
      raw,
      indent,
      ordered: null,
      contentCol: indent + marker.length + pad.length,
    };
  }
  return null;
}

/** リストの種別 (兄弟判定用)。順序リストはデリミタも区別する。 */
type ListKind = 'bullet' | 'ordered.' | 'ordered)';

/** 解析済みリスト行の種別を返す。 */
function lineKind(parsed: ParsedListLine): ListKind {
  if (parsed.ordered === null) return 'bullet';
  return parsed.ordered.delim === ')' ? 'ordered)' : 'ordered.';
}

/** 採番スタックの 1 階層。`contentCol` で階層を識別し `counter` で連番を刻む。 */
interface Frame {
  /** この階層の項目コンテンツ開始カラム (子はこれ以上インデントされる) */
  readonly contentCol: number;
  /** この階層の項目インデント */
  readonly indent: number;
  /** この階層のリスト種別 (種別が変わると別リスト = 採番リセット) */
  readonly kind: ListKind;
  /** 次に振る番号 (順序リストのみ意味を持つ) */
  counter: number;
}

/**
 * 順序リストマーカーを再構成する。番号のみ置換し、インデント・デリミタ・
 * マーカー後の空白・コンテンツはそのまま保持する。
 */
function rebuildOrderedLine(parsed: ParsedListLine, num: number): string {
  const om = ORDERED_ITEM_RE.exec(parsed.raw);
  if (om === null || parsed.ordered === null) return parsed.raw;
  const indent = om[1] ?? '';
  const pad = om[4] ?? ' ';
  const content = om[5] ?? '';
  return `${indent}${String(num)}${parsed.ordered.delim}${pad}${content}`;
}

/**
 * 行の配列を CommonMark のネスト規則で再採番し、書き換え後の行配列を返す。
 * 番号を持つ順序リスト行のみ書き換わる。箇条書き・非リスト行はそのまま。
 *
 * 純粋関数: 入力配列は変更しない。文字列 → 文字列。
 *
 * @param lines 文書の (該当範囲の) 行文字列配列
 * @returns 再採番後の行文字列配列 (同じ長さ)
 */
export function renumberLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  /** 現在アクティブな階層スタック (浅い順)。 */
  const stack: Frame[] = [];

  for (const raw of lines) {
    const parsed = parseListLine(raw);
    if (parsed === null) {
      // 非リスト行。空行はリストを継続しうるが、非空の非リスト行は
      // インデントされていなければリストを閉じる。ここでは保守的に:
      // - 空行 → スタックは維持 (リスト間の空行を許容)
      // - 非リスト・非空行 → その行のインデントより深いフレームを閉じる
      if (raw.trim().length === 0) {
        out.push(raw);
        continue;
      }
      const lead = /^\s*/.exec(raw)?.[0].length ?? 0;
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top === undefined) break;
        // 継続行 (コンテンツカラム以上のインデント) はその項目に属するので維持。
        if (lead >= top.contentCol) break;
        stack.pop();
      }
      out.push(raw);
      continue;
    }

    // リスト行: スタックを現在のインデントに合わせて畳む。
    // このリスト行より深い/等しくない (= より浅い or 同じインデントで別マーカー幅)
    // フレームを閉じる。同一インデントのフレームは「同じ階層の兄弟」として維持する。
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (parsed.indent < top.indent) {
        stack.pop();
        continue;
      }
      break;
    }

    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const kind = lineKind(parsed);

    // 同じインデントで種別 (箇条書き ⇄ 順序 / `.` ⇄ `)`) が変わったら別リスト。
    // CommonMark ではマーカー種別変更で新しいリストが始まるため採番をリセットする。
    if (top !== undefined && parsed.indent === top.indent && top.kind !== kind) {
      stack.pop();
    }
    const sib = stack.length > 0 ? stack[stack.length - 1] : undefined;

    if (sib !== undefined && parsed.indent === sib.indent && sib.kind === kind) {
      // 同じインデント & 同じ種別 = 同一リストの兄弟。順序リストなら番号を継続する。
      let nextCounter = sib.counter;
      if (parsed.ordered !== null) {
        out.push(rebuildOrderedLine(parsed, sib.counter));
        nextCounter = sib.counter + 1;
      } else {
        // 箇条書き兄弟: カウンタは進めない (順序リストではない) が、
        // 子リストの文脈のためフレームの contentCol を更新する。
        out.push(raw);
      }
      // 兄弟でマーカー幅が変わると子のカラムも変わるため contentCol を更新。
      // (readonly フィールドなので新フレームに差し替える)
      stack[stack.length - 1] = {
        contentCol: parsed.contentCol,
        indent: parsed.indent,
        kind,
        counter: nextCounter,
      };
      continue;
    }

    // ここに来るのは「より深い子」or「新しいトップレベル/新リスト」。新フレームを積む。
    // 子リストは 1 から再開する (親の連番を引き継がない) = AC-1。
    if (parsed.ordered !== null) {
      out.push(rebuildOrderedLine(parsed, 1));
      stack.push({ contentCol: parsed.contentCol, indent: parsed.indent, kind, counter: 2 });
    } else {
      out.push(raw);
      stack.push({ contentCol: parsed.contentCol, indent: parsed.indent, kind, counter: 1 });
    }
  }

  return out;
}

/**
 * 文書全体 (または改行区切りの Markdown 文字列) を再採番して返す。
 * 改行コードは LF に正規化しない — 入力に含まれる `\n` 区切りをそのまま保つ。
 *
 * @param markdown 改行 (`\n`) 区切りの Markdown 文字列
 * @returns 再採番後の Markdown 文字列
 */
export function renumberOrderedLists(markdown: string): string {
  const lines = markdown.split('\n');
  return renumberLines(lines).join('\n');
}

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
  if (parseListLine(text) !== null) return true;
  // 空でなく先頭が空白 (インデント) の行は継続行の可能性がある
  return text.length > 0 && /^\s/.test(text) && text.trim().length > 0;
}
