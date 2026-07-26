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

/**
 * 裸 URL (自動リンク) 検出用パターン。http/https のみ。
 * 走査側で `new RegExp(BARE_URL_PATTERN, 'g')` として使う (mini-md / live-preview 共有)。
 * 空白・山括弧のみ除外し、末尾に紛れた句読点/閉じ括弧は {@link trimUrlTail} で後処理する
 * (括弧を最初から除外すると Wikipedia 等の `..._(foo)` を取りこぼすため)。
 */
export const BARE_URL_PATTERN = 'https?://[^\\s<>]+';

// 末尾で URL の一部でないと判断する句読点類 (和文の 。、」 等も含む)。
const URL_TRAILING_PUNCT = new Set([
  '.', ',', ';', ':', '!', '?', '"', "'", ')', ']', '}', '>',
  '。', '、', '」', '』', '’', '”', '）',
]);

/**
 * 走査で得た生 URL から、末尾に紛れ込んだ句読点・閉じ括弧を取り除いて URL 本体を返す。
 * 例: `"https://ex.com/a)."` → `"https://ex.com/a"`。
 * ただし括弧が URL 内で釣り合う場合 (例: `".../Foo_(bar)"`) は末尾 `)` を保持する。
 */
export function trimUrlTail(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1] ?? '';
    if (ch === ')') {
      const slice = raw.slice(0, end);
      const opens = (slice.match(/\(/g) ?? []).length;
      const closes = (slice.match(/\)/g) ?? []).length;
      if (closes <= opens) break; // 釣り合う → URL の一部として残す
      end -= 1;
      continue;
    }
    if (URL_TRAILING_PUNCT.has(ch)) {
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

/** http(s) / mailto の外部リンク href か。内部相対リンクと区別する。 */
export function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
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
