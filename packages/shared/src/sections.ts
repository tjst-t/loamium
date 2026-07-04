/**
 * 見出しセクション抽出 (S9e5ca4-1: ![[note#見出し]] のセクション embed 用)。
 *
 * Obsidian 互換の解決規約:
 * - ATX 見出し (#〜######) のテキストと NFC 正規化 + 大文字小文字不区別で一致
 * - セクション = 一致した見出し行から「同レベル以下 (数値的に同じか小さい) の
 *   次の見出し行」の直前まで
 * - コードフェンス内の # 行は見出しとして扱わない
 *
 * 正本 (Markdown 文字列) は変更しない読み取り専用ビュー (priority 1)。
 */

const ATX_HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

function comparableHeading(s: string): string {
  return s.normalize('NFC').trim().toLowerCase();
}

/**
 * body から heading に一致するセクションを抜き出す。
 *
 * @param body ノート本文 (frontmatter 除去済みを推奨)
 * @param heading [[note#見出し]] の見出し部分 (# は含まない)
 * @returns 見出し行を含むセクション文字列。見出しが見つからなければ null
 */
export function extractSection(body: string, heading: string): string | null {
  const want = comparableHeading(heading);
  if (want.length === 0) return null;
  const lines = body.split('\n');

  let inFence = false;
  let fenceMark = '';
  let start = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const mark = fence[1] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMark = mark;
      } else if (mark[0] === fenceMark[0]) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = ATX_HEADING_RE.exec(line);
    if (m === null) continue;
    const lvl = (m[1] ?? '').length;
    if (start === -1) {
      if (comparableHeading(m[2] ?? '') === want) {
        start = i;
        level = lvl;
      }
    } else if (lvl <= level) {
      return lines.slice(start, i).join('\n');
    }
  }

  if (start === -1) return null;
  return lines.slice(start).join('\n');
}
