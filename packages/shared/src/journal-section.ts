/**
 * ジャーナルのセクション挿入ヘルパー (ADR-0009 / Sd22b1f-2)。
 *
 * journal-append ステップの section 指定に使う。単発の journal-append API/CLI
 * も同じ実装を共有する (Story Sd22b1f-3 で再利用する seam)。
 *
 * insertUnderHeading(content, heading, text):
 *   - NFC 正規化で見出しテキストを照合する
 *   - 見出しが存在すれば、その見出しセクションの末尾 (次の同レベル以上の見出し直前) に text を追記する
 *   - 見出しが存在しなければ、ファイル末尾に見出し行 + text を追記する
 *   - text は改行で終端しない場合も改行を補う (appendText と同じ規約)
 */

/**
 * ATX 見出し行の正規表現。
 * グループ 1: ## などの # 列 (レベル)
 * グループ 2: 見出しテキスト (前後空白なし)
 */
const ATX_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;

/**
 * 文字列を改行で終端する。LF に正規化する。
 */
function ensureTrailingNewline(s: string): string {
  const lf = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

/**
 * ジャーナル本文 `content` の ATX 見出し `heading` 配下の末尾に `text` を挿入する。
 *
 * - heading は NFC 正規化して照合する (大小文字は区別する)。
 * - 見出しが存在しない場合はファイル末尾に `## heading\n` + text を追記する。
 * - text は改行で終端しない場合も LF を補う。
 * - 戻り値は常に LF 改行の文字列。
 *
 * [AC-Sd22b1f-2-1]
 */
export function insertUnderHeading(content: string, heading: string, text: string): string {
  const normalizedHeading = heading.normalize('NFC');
  const insertText = ensureTrailingNewline(text.normalize('NFC'));
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // 最後の行が空文字 (末尾改行によるスプリット) を考慮する
  // lines.join('\n') で元に戻せる形を保持する

  // 対象見出しの行インデックスを探す (NFC 照合)
  let headingLineIdx = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = ATX_HEADING_RE.exec(lines[i] ?? '');
    if (m !== null) {
      const lineText = (m[2] ?? '').normalize('NFC');
      if (lineText === normalizedHeading) {
        headingLineIdx = i;
        headingLevel = (m[1] ?? '').length;
        break;
      }
    }
  }

  if (headingLineIdx === -1) {
    // 見出しが存在しない → ファイル末尾に見出し + text を追記する
    // content が空でも、改行がなくても安全に追記する
    const base = content === '' ? '' : ensureTrailingNewline(content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    return `${base}## ${normalizedHeading}\n${insertText}`;
  }

  // 見出しが存在する → セクション末尾 (次の同レベル以上の見出し直前) を探す
  // 同レベル以上 = headingLevel 以下の # 数の見出し
  let sectionEndLineIdx = lines.length; // 次の同レベル以上見出しの行インデックス (排他)
  for (let i = headingLineIdx + 1; i < lines.length; i++) {
    const m = ATX_HEADING_RE.exec(lines[i] ?? '');
    if (m !== null) {
      const level = (m[1] ?? '').length;
      if (level <= headingLevel) {
        sectionEndLineIdx = i;
        break;
      }
    }
  }

  // セクション末尾の直前 (空行は保持したまま) に text を挿入する
  // lines[sectionEndLineIdx - 1] が空行なら、その前に挿入する (末尾空行を保持)
  // ただし、見出し行のすぐ次なら末尾空行考慮は不要

  // 挿入位置: sectionEndLineIdx の直前
  // text に含まれる改行 (LF) を lines 配列に変換して splice する
  const insertLines = insertText.replace(/\n$/, '').split('\n');

  const newLines = [
    ...lines.slice(0, sectionEndLineIdx),
    ...insertLines,
    ...lines.slice(sectionEndLineIdx),
  ];

  // join すると末尾の空文字要素 (元の末尾改行由来) が保持され、結果が '\n' で終わる
  // ただし元の content が改行で終わっていない場合 (= lines に末尾 '' がない) でも
  // insertText 自身が '\n' で終わるため、その場合も末尾改行を付ける
  const joined = newLines.join('\n');
  // 末尾改行を補う: joined が '\n' で終わっていなければ補う
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}
