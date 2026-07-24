/**
 * 3-way diff3 マージ実装 (S2df65d-1 / ADR-0030)。
 *
 * 純 JS (外部依存なし)。行単位 LCS + ハンク境界による 3-way マージ。
 * 保守的競合検出 (疑わしきは競合側に倒す)。
 *
 * エクスポート:
 *   diff3Merge(base, ours, theirs): Diff3Result
 *
 * アルゴリズム概要:
 *   1. base→ours、base→theirs の行単位 diff を LCS から計算
 *   2. base の各行を順に走査し、変更の分類を行う:
 *      - 片方だけが変更: 非競合 (その変更を採用)
 *      - 両方が同じ変更: 非競合・冪等 (変更を1回だけ適用)
 *      - 両方が異なる変更: 競合 (ConflictHunk に追加)
 *   3. 行前への純挿入 (deleted=[]) も base 走査の各ステップで先に適用
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** 競合ハンク: base に対し ours と theirs が同一行域を異なる内容に変更した範囲 */
export interface ConflictHunk {
  /** merged テキストにおける競合ハンクの開始行 (0 始まり) */
  startLine: number;
  /** merged テキストにおける競合ハンクの終了行 */
  endLine: number;
  /** ours (ローカル編集) 側の行配列 */
  ours: string[];
  /** theirs (リモート) 側の行配列 */
  theirs: string[];
}

/** diff3Merge の戻り値 */
export interface Diff3Result {
  /** マージ済みテキスト (競合ハンクは placeholder 行で埋まる — ダイアログで解決前) */
  merged: string;
  /** 競合ハンク一覧 (空 = 非競合自動統合済み) */
  conflicts: ConflictHunk[];
}

// ---------------------------------------------------------------------------
// 内部型
// ---------------------------------------------------------------------------

/**
 * 行単位 diff の変更チャンク。
 * - type 'change': baseIdx から削除して挿入
 * - type 'insert': baseIdx の行の前に挿入 (deleted は空)
 */
interface Chunk {
  type: 'change' | 'insert';
  /** base の変更が始まる行インデックス */
  baseIdx: number;
  /** 削除される base 行の配列 */
  deleted: string[];
  /** 挿入される行の配列 */
  inserted: string[];
}

// ---------------------------------------------------------------------------
// LCS (Longest Common Subsequence)
// ---------------------------------------------------------------------------

/**
 * 2 つの行配列の LCS を (baseIdx, modifiedIdx) ペアで返す。
 * O(n*m) — 実用的なノートサイズ (数千行) では問題ない。
 */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// diff: base → modified の Chunk 列
// ---------------------------------------------------------------------------

/**
 * base → modified の行単位 diff を Chunk 列として返す。
 *
 * 純挿入 (deleted=[]) の場合:
 *   - baseIdx は「その前の共通行の次のインデックス」= 挿入が起こる位置
 *   - type = 'insert'
 * 削除・変更の場合:
 *   - type = 'change'
 */
function diffLines(base: string[], modified: string[]): Chunk[] {
  const common = lcs(base, modified);
  const chunks: Chunk[] = [];

  let bi = 0;
  let mi = 0;
  let ci = 0;

  while (ci < common.length) {
    const [cb, cm] = common[ci]!;
    if (bi < cb || mi < cm) {
      // base 行が削除されるか、modified 行が挿入されるか、その両方
      const deleted = base.slice(bi, cb);
      const inserted = modified.slice(mi, cm);
      chunks.push({
        type: deleted.length === 0 ? 'insert' : 'change',
        baseIdx: bi,
        deleted,
        inserted,
      });
    }
    bi = cb + 1;
    mi = cm + 1;
    ci++;
  }
  // 末尾残余
  if (bi < base.length || mi < modified.length) {
    const deleted = base.slice(bi);
    const inserted = modified.slice(mi);
    chunks.push({
      type: deleted.length === 0 ? 'insert' : 'change',
      baseIdx: bi,
      deleted,
      inserted,
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Chunk マップ
// ---------------------------------------------------------------------------

interface ChunkMap {
  /**
   * base 行インデックス → この base 行の直前に挿入される行 (純挿入 Chunk の inserted)
   * 「base[bi] の前の行」として処理される
   */
  insertBefore: Map<number, string[]>;
  /**
   * base 行インデックス → この base 行から始まる変更 Chunk
   * (deleted.length >= 1)
   */
  changeAt: Map<number, Chunk>;
  /**
   * base.length の位置への末尾追記
   */
  appendAfter: string[] | null;
}

function buildChunkMap(chunks: Chunk[], baseLen: number): ChunkMap {
  const insertBefore = new Map<number, string[]>();
  const changeAt = new Map<number, Chunk>();
  let appendAfter: string[] | null = null;

  for (const chunk of chunks) {
    if (chunk.type === 'insert') {
      if (chunk.baseIdx >= baseLen) {
        // 末尾追記
        appendAfter = chunk.inserted;
      } else {
        // base[chunk.baseIdx] の前に挿入
        const existing = insertBefore.get(chunk.baseIdx) ?? [];
        insertBefore.set(chunk.baseIdx, [...existing, ...chunk.inserted]);
      }
    } else {
      // change
      if (chunk.baseIdx >= baseLen) {
        // 末尾への変更 (deleted が末尾行以降 → 末尾追記として扱う)
        appendAfter = chunk.inserted;
      } else {
        changeAt.set(chunk.baseIdx, chunk);
      }
    }
  }

  return { insertBefore, changeAt, appendAfter };
}

// ---------------------------------------------------------------------------
// メインの 3-way マージ
// ---------------------------------------------------------------------------

/**
 * 行単位 3-way diff3 マージ。
 *
 * @param base   最後に取得したリモート内容 (共通祖先)
 * @param ours   ローカル編集バッファ
 * @param theirs 新しいリモート内容
 * @returns { merged, conflicts }
 */
export function diff3Merge(base: string, ours: string, theirs: string): Diff3Result {
  // 末尾改行補完 (ピュア Markdown は LF で終わるのが望ましい)
  const normBase = base.length > 0 && !base.endsWith('\n') ? base + '\n' : base;
  const normOurs = ours.length > 0 && !ours.endsWith('\n') ? ours + '\n' : ours;
  const normTheirs = theirs.length > 0 && !theirs.endsWith('\n') ? theirs + '\n' : theirs;

  // 行配列に分割 (末尾改行による空要素を除去)
  const splitLines = (s: string): string[] => {
    if (s === '') return [];
    const lines = s.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  const baseLines = splitLines(normBase);
  const oursLines = splitLines(normOurs);
  const theirsLines = splitLines(normTheirs);

  // --- 早期終了 ---
  // すべて同一
  if (normOurs === normBase && normTheirs === normBase) {
    return { merged: normBase, conflicts: [] };
  }
  // 同一変更の冪等: ours === theirs
  if (normOurs === normTheirs) {
    return { merged: normOurs, conflicts: [] };
  }
  // ours が base と同一 → theirs を採用
  if (normOurs === normBase) {
    return { merged: normTheirs, conflicts: [] };
  }
  // theirs が base と同一 → ours を採用
  if (normTheirs === normBase) {
    return { merged: normOurs, conflicts: [] };
  }

  // base が空: ours と theirs が両方新規追加。同一でなければ競合
  if (baseLines.length === 0) {
    const conflict: ConflictHunk = {
      startLine: 0,
      endLine: 0,
      ours: oursLines,
      theirs: theirsLines,
    };
    return {
      merged: buildConflictPlaceholder(conflict),
      conflicts: [conflict],
    };
  }

  const ourChunks = diffLines(baseLines, oursLines);
  const theirChunks = diffLines(baseLines, theirsLines);
  const ourMap = buildChunkMap(ourChunks, baseLines.length);
  const theirMap = buildChunkMap(theirChunks, baseLines.length);

  const mergedLines: string[] = [];
  const conflicts: ConflictHunk[] = [];
  let lineOffset = 0;

  // base の各行を走査
  let bi = 0;
  while (bi < baseLines.length) {
    // ──────────────────────────────────────────────────────────────────
    // 1. base[bi] の前への純挿入を処理
    // ──────────────────────────────────────────────────────────────────
    const ourInsert = ourMap.insertBefore.get(bi) ?? null;
    const theirInsert = theirMap.insertBefore.get(bi) ?? null;

    if (ourInsert !== null || theirInsert !== null) {
      if (ourInsert !== null && theirInsert === null) {
        // ours だけが挿入
        for (const line of ourInsert) { mergedLines.push(line); lineOffset++; }
      } else if (ourInsert === null && theirInsert !== null) {
        // theirs だけが挿入
        for (const line of theirInsert) { mergedLines.push(line); lineOffset++; }
      } else if (ourInsert !== null && theirInsert !== null) {
        if (arraysEqual(ourInsert, theirInsert)) {
          // 同一挿入 → 1回だけ
          for (const line of ourInsert) { mergedLines.push(line); lineOffset++; }
        } else {
          // 保守的: 異なる挿入が同じ位置 → 競合
          const conflict: ConflictHunk = {
            startLine: lineOffset,
            endLine: lineOffset,
            ours: ourInsert,
            theirs: theirInsert,
          };
          conflicts.push(conflict);
          mergedLines.push(buildConflictPlaceholder(conflict));
          lineOffset++;
        }
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 2. base[bi] の行自体の変更を処理
    // ──────────────────────────────────────────────────────────────────
    const ourChange = ourMap.changeAt.get(bi);
    const theirChange = theirMap.changeAt.get(bi);

    if (ourChange === undefined && theirChange === undefined) {
      // 変更なし: base 行をそのまま採用
      mergedLines.push(baseLines[bi]!);
      lineOffset++;
      bi++;
      continue;
    }

    if (ourChange !== undefined && theirChange === undefined) {
      // ours だけが変更 (削除 + 挿入)
      // theirs がこの範囲内に変更を持っていないか追加確認 (保守的)
      const theirOverlap = hasTheirChangeInRange(
        bi,
        bi + ourChange.deleted.length,
        theirMap,
      );
      if (theirOverlap) {
        // 保守的: 重複範囲 → 競合
        const oursResult = ourChange.inserted;
        const theirsResult = extractTheirLinesInRange(bi, bi + ourChange.deleted.length, theirMap, baseLines);
        const conflict: ConflictHunk = {
          startLine: lineOffset,
          endLine: lineOffset,
          ours: oursResult,
          theirs: theirsResult,
        };
        conflicts.push(conflict);
        mergedLines.push(buildConflictPlaceholder(conflict));
        lineOffset++;
      } else {
        for (const line of ourChange.inserted) { mergedLines.push(line); lineOffset++; }
      }
      bi += ourChange.deleted.length;
      continue;
    }

    if (ourChange === undefined && theirChange !== undefined) {
      // theirs だけが変更
      const ourOverlap = hasOurChangeInRange(
        bi,
        bi + theirChange.deleted.length,
        ourMap,
      );
      if (ourOverlap) {
        // 保守的: 重複範囲 → 競合
        const oursResult = extractOurLinesInRange(bi, bi + theirChange.deleted.length, ourMap, baseLines);
        const theirsResult = theirChange.inserted;
        const conflict: ConflictHunk = {
          startLine: lineOffset,
          endLine: lineOffset,
          ours: oursResult,
          theirs: theirsResult,
        };
        conflicts.push(conflict);
        mergedLines.push(buildConflictPlaceholder(conflict));
        lineOffset++;
      } else {
        for (const line of theirChange.inserted) { mergedLines.push(line); lineOffset++; }
      }
      bi += theirChange.deleted.length;
      continue;
    }

    // 両方が変更 (ourChange !== undefined && theirChange !== undefined)
    if (ourChange !== undefined && theirChange !== undefined) {
      // 変更範囲の終了を揃える
      const ourEnd = bi + ourChange.deleted.length;
      const theirEnd = bi + theirChange.deleted.length;
      const rangeEnd = Math.max(ourEnd, theirEnd);

      // 両者のマージ後の行を取得
      const oursResult = buildResultInRange(bi, rangeEnd, ourChange, ourMap, baseLines);
      const theirsResult = buildResultInRange(bi, rangeEnd, theirChange, theirMap, baseLines);

      if (arraysEqual(oursResult, theirsResult)) {
        // 同一変更 → 1回だけ採用
        for (const line of oursResult) { mergedLines.push(line); lineOffset++; }
      } else {
        // 異なる変更 → 競合
        const conflict: ConflictHunk = {
          startLine: lineOffset,
          endLine: lineOffset,
          ours: oursResult,
          theirs: theirsResult,
        };
        conflicts.push(conflict);
        mergedLines.push(buildConflictPlaceholder(conflict));
        lineOffset++;
      }
      bi = rangeEnd;
      continue;
    }

    // フォールスルー (ここには来ない)
    mergedLines.push(baseLines[bi]!);
    lineOffset++;
    bi++;
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. base 末尾 (= base.length) への追記
  // ──────────────────────────────────────────────────────────────────

  // 末尾への pure insert (insertBefore.get(baseLines.length))
  const ourEndInsert = ourMap.insertBefore.get(baseLines.length) ?? null;
  const theirEndInsert = theirMap.insertBefore.get(baseLines.length) ?? null;
  const ourAppend = ourMap.appendAfter;
  const theirAppend = theirMap.appendAfter;

  // 末尾挿入をまとめる (appendAfter と insertBefore[len] を統合)
  const ourTail = [...(ourEndInsert ?? []), ...(ourAppend ?? [])];
  const theirTail = [...(theirEndInsert ?? []), ...(theirAppend ?? [])];

  if (ourTail.length > 0 || theirTail.length > 0) {
    if (ourTail.length > 0 && theirTail.length === 0) {
      for (const line of ourTail) { mergedLines.push(line); lineOffset++; }
    } else if (ourTail.length === 0 && theirTail.length > 0) {
      for (const line of theirTail) { mergedLines.push(line); lineOffset++; }
    } else {
      if (arraysEqual(ourTail, theirTail)) {
        for (const line of ourTail) { mergedLines.push(line); lineOffset++; }
      } else {
        const conflict: ConflictHunk = {
          startLine: lineOffset,
          endLine: lineOffset,
          ours: ourTail,
          theirs: theirTail,
        };
        conflicts.push(conflict);
        mergedLines.push(buildConflictPlaceholder(conflict));
      }
    }
  }

  // マージ済みテキストを構築
  let merged = mergedLines.join('\n');
  if (merged.length > 0 && !merged.endsWith('\n')) {
    merged += '\n';
  }

  return { merged, conflicts };
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * theirs が [fromIdx, toIdx) の base 行範囲内に変更を持っているか確認する。
 * (保守的競合検出: 重複範囲があれば競合扱い)
 *
 * 隣接 insert+change 共存の保守的検出 (review fix / medium②):
 *   changeAt[fromIdx] は base[fromIdx..toIdx) を変更する。
 *   insertBefore[toIdx] は「base[toIdx] の前への挿入」= 変更範囲の直後に接触する挿入であり、
 *   同一 base 行域に INSERT + CHANGE が共存するため保守的に競合として扱う (ADR-0030)。
 *   同様に insertBefore[fromIdx..toIdx] の任意位置の挿入も競合候補とする。
 */
function hasTheirChangeInRange(fromIdx: number, toIdx: number, theirMap: ChunkMap): boolean {
  for (let i = fromIdx; i < toIdx; i++) {
    if (theirMap.changeAt.has(i)) return true;
    // base[i] の前への挿入 (insertBefore[i]) も同一 base 位置の競合として検出する
    if (theirMap.insertBefore.has(i)) return true;
  }
  // 変更範囲の末端 (= base[toIdx] の前) への挿入も競合として検出する
  // (changeAt が base[fromIdx..toIdx) を削除する場合、その直後への挿入と共存するため)
  if (theirMap.insertBefore.has(toIdx)) return true;
  return false;
}

function hasOurChangeInRange(fromIdx: number, toIdx: number, ourMap: ChunkMap): boolean {
  for (let i = fromIdx; i < toIdx; i++) {
    if (ourMap.changeAt.has(i)) return true;
    // base[i] の前への挿入 (insertBefore[i]) も同一 base 位置の競合として検出する
    if (ourMap.insertBefore.has(i)) return true;
  }
  // 変更範囲の末端 (= base[toIdx] の前) への挿入も競合として検出する
  if (ourMap.insertBefore.has(toIdx)) return true;
  return false;
}

/**
 * theirs の [fromIdx, toIdx) 範囲を変換した結果行を返す。
 * 変更がない行は base から取得。
 */
function extractTheirLinesInRange(
  fromIdx: number,
  toIdx: number,
  theirMap: ChunkMap,
  baseLines: string[],
): string[] {
  const result: string[] = [];
  let i = fromIdx;
  while (i < toIdx) {
    const ins = theirMap.insertBefore.get(i);
    if (ins) result.push(...ins);
    const ch = theirMap.changeAt.get(i);
    if (ch) {
      result.push(...ch.inserted);
      i += ch.deleted.length;
    } else {
      result.push(baseLines[i]!);
      i++;
    }
  }
  return result;
}

function extractOurLinesInRange(
  fromIdx: number,
  toIdx: number,
  ourMap: ChunkMap,
  baseLines: string[],
): string[] {
  const result: string[] = [];
  let i = fromIdx;
  while (i < toIdx) {
    const ins = ourMap.insertBefore.get(i);
    if (ins) result.push(...ins);
    const ch = ourMap.changeAt.get(i);
    if (ch) {
      result.push(...ch.inserted);
      i += ch.deleted.length;
    } else {
      result.push(baseLines[i]!);
      i++;
    }
  }
  return result;
}

/**
 * [fromIdx, rangeEnd) の base 範囲で primaryChange を適用した後の行列。
 * rangeEnd が primaryChange の範囲を超える場合は、map から追加の変更を取得して補完。
 */
function buildResultInRange(
  fromIdx: number,
  rangeEnd: number,
  primaryChange: Chunk,
  map: ChunkMap,
  baseLines: string[],
): string[] {
  const result: string[] = [...primaryChange.inserted];
  // primaryChange 後の残余 base 行を処理
  let i = fromIdx + primaryChange.deleted.length;
  while (i < rangeEnd) {
    const ins = map.insertBefore.get(i);
    if (ins) result.push(...ins);
    const ch = map.changeAt.get(i);
    if (ch) {
      result.push(...ch.inserted);
      i += ch.deleted.length;
    } else {
      result.push(baseLines[i]!);
      i++;
    }
  }
  return result;
}

/**
 * 競合プレースホルダー行を生成する。
 * 注意: これは merged テキスト内での内部識別用であり、
 * ファイルには書き込まれない (ダイアログで解決後に置換される)。
 * ピュア Markdown には競合マーカー (<<<, ===, >>>) を一切書かない。
 */
function buildConflictPlaceholder(conflict: ConflictHunk): string {
  return `\u{1F4AC}CONFLICT:${conflict.startLine}`;
}
