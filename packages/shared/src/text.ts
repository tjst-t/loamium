/**
 * テキスト正規化 — 改行 LF 固定 (VISION tech_constraints: UTF-8 / LF)。
 */

/** CRLF / CR を LF に正規化する。 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 追記結果を組み立てる。
 * - 既存末尾に改行が無ければ補い、追記分も改行で終端する
 * - 常に LF 改行 (POSIX / Git フレンドリー)
 */
export function appendText(existing: string, addition: string): string {
  const add = toLf(addition);
  const addTerminated = add.endsWith('\n') ? add : `${add}\n`;
  if (existing === '') {
    return addTerminated;
  }
  const base = existing.endsWith('\n') ? existing : `${existing}\n`;
  return base + addTerminated;
}

/** 文字列中の部分文字列の出現回数を数える (オーバーラップなし)。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}
