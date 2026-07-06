/**
 * タグ候補補完の共通ロジック (Sprint S45fa45)。
 *
 * tags プロパティ値・本文の `#` 入力の両方が同一のこの純関数を通す
 * (「タグ補完ソースは共通化」— 既存タグ + 件数 + 新規作成)。
 * 記法は Obsidian 互換の `#tag` のまま — 独自記法は導入しない
 * (DESIGN_PRINCIPLES priority 1 / 4)。UI 依存を持たない純ロジックとして
 * packages/shared に置き、ユニットテストで固める (coding_conventions)。
 */
import type { TagCount } from './schemas.js';

/** 補完メニュー 1 項目。isCreate=true は末尾の「新規作成: #xxx」。 */
export interface TagSuggestion {
  /** タグ名 (`#` なし、NFC 正規化)。 */
  tag: string;
  /** 出現件数 (新規作成項目は 0)。 */
  count: number;
  /** 「新規作成: #xxx」項目かどうか。 */
  isCreate: boolean;
  /** 表示名中のクエリ一致範囲 (mark ハイライト用)。null = 一致なし / 全件。 */
  matchRange: [number, number] | null;
}

// Obsidian 互換タグの文字クラス (extract.ts の TAG_RE と同一の本体部)。
const TAG_NAME_RE = /^[\p{L}\p{M}\p{N}_/-]+$/u;

/** 純数字タグ (Obsidian では無効) かどうか。 */
function isNumericOnly(tag: string): boolean {
  return /^[\p{N}]+$/u.test(tag);
}

/**
 * 「新規作成」候補として成立する妥当なタグ名か。
 * Obsidian 互換の文字のみ・純数字でない・前後に区切り記号が無いこと。
 */
export function isValidTagName(name: string): boolean {
  const t = name.normalize('NFC');
  if (t.length === 0 || isNumericOnly(t)) return false;
  if (t.startsWith('/') || t.startsWith('-') || t.endsWith('/') || t.endsWith('-')) return false;
  return TAG_NAME_RE.test(t);
}

/** クエリ先頭の `#` を落とし NFC 正規化する (入力は `#sam` / `sam` どちらも可)。 */
export function normalizeTagQuery(rawQuery: string): string {
  return rawQuery.replace(/^#+/, '').normalize('NFC');
}

/**
 * 既存タグ (件数付き) をクエリで絞り込み、末尾に「新規作成」候補を足す。
 *
 * - 入力配列の順序を保持する (server 側で件数降順→タグ昇順に整列済み)。
 * - 大文字小文字を無視した部分一致。一致範囲を matchRange で返す。
 * - クエリが空なら全件 (matchRange=null)。
 * - クエリが妥当なタグ名で、かつ同名の既存タグが無いときだけ「新規作成」を足す。
 */
export function filterTagSuggestions(
  tags: readonly TagCount[],
  rawQuery: string,
): TagSuggestion[] {
  const query = normalizeTagQuery(rawQuery);
  const qCmp = query.toLowerCase();
  const out: TagSuggestion[] = [];
  let exactExists = false;
  for (const { tag, count } of tags) {
    const name = tag.normalize('NFC');
    const cmp = name.toLowerCase();
    if (cmp === qCmp && qCmp.length > 0) exactExists = true;
    if (qCmp.length === 0) {
      out.push({ tag: name, count, isCreate: false, matchRange: null });
      continue;
    }
    const idx = cmp.indexOf(qCmp);
    if (idx < 0) continue;
    out.push({ tag: name, count, isCreate: false, matchRange: [idx, idx + query.length] });
  }
  if (query.length > 0 && !exactExists && isValidTagName(query)) {
    out.push({ tag: query, count: 0, isCreate: true, matchRange: null });
  }
  return out;
}
