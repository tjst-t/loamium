/**
 * リスト行の「採番」と「タイプ変換 (箇条書き ⇄ 番号付き)」の DOM 非依存 純関数群
 * (Story S6848dc-5 採番 / S6848dc-6 変換)。
 *
 * 設計方針 (重要 — 二重管理の排除):
 * - このモジュールは **`@codemirror/*` にも DOM にも一切依存しない**。純粋な
 *   文字列 → 文字列 (行配列 → 行配列)。UI (エディタバッファ) とサーバ
 *   (エージェントのファイル内容書き換え) の **両方から import して同じロジックを
 *   共有**する (CLAUDE.md「二重管理を避ける」)。
 * - 採番の中核 (`renumberLines` / `renumberOrderedLists`) はもともと
 *   `packages/ui/src/list-renumber.ts` にあったが、変換 (convert) と採番は表裏一体
 *   (番号付きへ変換したら採番が要る) なので **shared へ集約**した。UI の
 *   `list-renumber.ts` はここから re-export し、`@codemirror/state` に依存する
 *   `renumberChangesForRange` だけを UI 側に残す (既存テスト・`outline.ts` の
 *   import を壊さない)。
 * - 正本はピュア Markdown 文字列 1 本。ブロック ID・独自記法は一切書き込まない。
 *   採番は順序リストマーカーの **番号** (`1` → `2` 等) のみを書き換え、変換は
 *   マーカー記号 (`-`/`*`/`+` ⇄ `1.`) のみを書き換える。インデント幅・マーカー後の
 *   空白・コンテンツ (チェックボックス `[ ]`・インラインフィールド含む) はそのまま
 *   保持する。
 * - 階層判定は **先頭空白 (インデント量)** で行う (CommonMark のネスト規則)。
 */

/** 行頭空白 + 順序リストマーカー (数字 + `.`|`)` + 1 つ以上の空白) を捉える正規表現。 */
const ORDERED_ITEM_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;

/** 行頭空白 + 箇条書きマーカー (`-`|`*`|`+` + 1 つ以上の空白) を捉える正規表現。 */
const BULLET_ITEM_RE = /^(\s*)([-*+])(\s+)(.*)$/;

/** 変換先リストタイプ。 */
export type ListConvertTarget = 'bullet' | 'ordered';

/** 既定の箇条書きマーカー (順序 → 箇条書き変換で既存マーカーが無いときに使う)。 */
export const DEFAULT_BULLET_MARKER = '-';

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

// ---- リストタイプ変換 (箇条書き ⇄ 番号付き) — S6848dc-6 ----------------------

/**
 * 対象範囲 (行配列) 内のリスト行を bullet ⇄ ordered へ一括変換する純関数。
 *
 * 変換仕様 (AC-4):
 * - target='ordered': 箇条書き (`-`/`*`/`+`) を `1. ` へ変換する。番号は変換後に
 *   `renumberLines` で CommonMark ネスト規則に従い採番する (AC-3。各階層で 1 から
 *   連番、子リストは 1 から再開)。既に順序リストの行はデリミタ (`.`/`)`) を保持する。
 * - target='bullet': 順序リスト (`1.`/`1)`) を箇条書きマーカーへ変換する。マーカーは、
 *   同じインデント階層に既存の箇条書き行があればそのマーカー種別に合わせ、無ければ
 *   `bulletMarker` (既定 `-`) を使う (AC-4: 既存の箇条書きマーカー種別に合わせる)。
 * - インデント (先頭空白)・ネスト・子項目・マーカー後の空白・コンテンツ
 *   (チェックボックス `[ ]` / インラインフィールド `[due:: ...]` を含む) はすべて
 *   保持する。非リスト行・空行はそのまま。
 *
 * チェックボックスの扱い (decisions): `- [ ] task` を ordered へ変換すると
 * `1. [ ] task` になる (マーカーのみ置換し `[ ]` はコンテンツとして温存)。番号付き +
 * チェックボックスは GitHub 等では素通しされる (タスクリスト装飾は付かないが Markdown
 * として妥当) ため、コンテンツを触らず保持する方針を採る。bullet へ戻せば元の
 * タスクリストに復帰する (round-trip 可)。
 *
 * 純粋関数: 入力配列は変更しない。文字列 → 文字列。
 *
 * @param lines        変換対象の行文字列配列 (選択範囲 or リストブロック)
 * @param target       'bullet' | 'ordered'
 * @param bulletMarker ordered → bullet で既存箇条書きが無いとき使うマーカー (既定 '-')
 * @returns 変換後の行文字列配列 (同じ長さ)
 */
export function convertListLines(
  lines: readonly string[],
  target: ListConvertTarget,
  bulletMarker: string = DEFAULT_BULLET_MARKER,
): string[] {
  // 段階 1: マーカー記号の置換のみ行う (採番は段階 2 に委譲)。
  // インデント階層ごとの「既存箇条書きマーカー」を覚えておき、ordered → bullet で
  // その階層の既存種別に合わせる (AC-4)。
  const bulletByIndent = new Map<number, string>();
  const converted: string[] = [];

  for (const raw of lines) {
    const parsed = parseListLine(raw);
    if (parsed === null) {
      converted.push(raw);
      continue;
    }

    if (parsed.ordered === null) {
      // 元が箇条書き。この階層のマーカー種別を記録する (bullet 変換時の参照用)。
      const bm = BULLET_ITEM_RE.exec(raw);
      if (bm !== null) bulletByIndent.set(parsed.indent, bm[2] ?? bulletMarker);
      if (target === 'bullet') {
        // 既に箇条書き → そのまま (マーカー種別も変えない)。
        converted.push(raw);
      } else {
        // 箇条書き → 番号付き。番号は仮に 1 を置き、段階 2 の renumberLines が採番する。
        converted.push(bulletToOrdered(raw));
      }
      continue;
    }

    // 元が順序リスト。
    if (target === 'ordered') {
      // 既に順序リスト → デリミタ・番号はそのまま (段階 2 の renumberLines が採番)。
      converted.push(raw);
    } else {
      // 順序 → 箇条書き。この階層に既存箇条書きマーカーがあればそれに合わせる。
      const marker = bulletByIndent.get(parsed.indent) ?? bulletMarker;
      converted.push(orderedToBullet(raw, marker));
    }
  }

  // 段階 2: ordered へ変換したなら CommonMark ネスト規則で採番する (AC-3)。
  // bullet 変換のみのときは採番不要 (順序リスト行が残らない前提だが、範囲外の既存
  // 順序リストを壊さないため常に renumberLines を通しても冪等 — ただし変換対象外の
  // 順序リストの番号を勝手に振り直さないよう、bullet target では採番をスキップする)。
  if (target === 'ordered') {
    return renumberLines(converted);
  }
  return converted;
}

/**
 * 改行 (`\n`) 区切りの Markdown 文字列全体のリスト行を bullet ⇄ ordered へ変換する。
 * サーバ側 (エージェント: 全リスト変換) 用の便利ラッパー。改行コードは保持する。
 */
export function convertListMarkdown(
  markdown: string,
  target: ListConvertTarget,
  bulletMarker: string = DEFAULT_BULLET_MARKER,
): string {
  const lines = markdown.split('\n');
  return convertListLines(lines, target, bulletMarker).join('\n');
}

/**
 * 箇条書き行を順序リスト行へ変換する (番号は仮に 1)。マーカー後の空白・コンテンツ
 * (チェックボックス等) は保持する。リスト行でなければそのまま返す。
 */
function bulletToOrdered(raw: string): string {
  const bm = BULLET_ITEM_RE.exec(raw);
  if (bm === null) return raw;
  const indent = bm[1] ?? '';
  const pad = bm[3] ?? ' ';
  const content = bm[4] ?? '';
  return `${indent}1.${pad}${content}`;
}

/**
 * 順序リスト行を箇条書き行へ変換する。マーカー後の空白・コンテンツ
 * (チェックボックス等) は保持する。リスト行でなければそのまま返す。
 *
 * @param marker 使用する箇条書きマーカー (`-`/`*`/`+`)
 */
function orderedToBullet(raw: string, marker: string): string {
  const om = ORDERED_ITEM_RE.exec(raw);
  if (om === null) return raw;
  const indent = om[1] ?? '';
  const pad = om[4] ?? ' ';
  const content = om[5] ?? '';
  return `${indent}${marker}${pad}${content}`;
}
