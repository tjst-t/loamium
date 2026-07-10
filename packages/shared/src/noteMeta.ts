/**
 * ノートメタ集約 (S11493d-1) — ノート 1 件から見出し・リンク・タグ・字数等を抽出する。
 *
 * 原則:
 * - 正本 (Markdown 文字列) は一切変更しない読み取り専用ビュー
 * - コードフェンス (``` / ~~~) 内と frontmatter は見出し・リンク・字数の対象外
 * - CJK 各文字を 1 ワードとしてカウントする
 *   (空白分割では単語境界が存在しない。Obsidian でも同様の扱いが一般的)
 *
 * wordCount ルール (テストドキュメントに記載):
 * - frontmatter と code-fence ブロックを除外した本文テキストに対して
 * - 空白 (ASCII / Unicode) で分割した「非空トークン」の数を基本とし、
 * - CJK 文字 (\p{sc=Han}|\p{sc=Hiragana}|\p{sc=Katakana}|\p{sc=Hangul}) は
 *   それぞれ 1 ワードと数える。非 CJK トークン内に混在する CJK 文字も正確に計上する。
 * charCount:
 * - 同じ除外済み本文の Unicode 文字数 (スペース・改行を含む)
 */

import { parseNote } from './markdown.js';
import { extractLinks, extractTags } from './extract.js';

/** ATX 見出し (# .. ######) — コードフェンス・frontmatter 外 */
export interface NoteHeading {
  /** 見出しレベル (1–6) */
  level: number;
  /** 見出しテキスト (先頭 `#` と空白を除いたもの。inline markup はそのまま保持) */
  text: string;
  /** ノート全体における 1 始まりの行番号 */
  line: number;
}

/** アウトゴーイングリンク (1 件) */
export interface OutgoingLink {
  /** リンクターゲット (NFC 正規化済み。heading / alias を除く) */
  target: string;
  /**
   * target を vault 内パスに解決した結果 (vault-relative path)。
   * 解決できなければ null (壊れたリンク)。
   */
  resolvedPath: string | null;
  /** リンク元テキスト全体 (例: "[[note#heading|別名]]") */
  raw: string;
}

// ATX 見出し: 行頭 1–6 個の # + スペース + テキスト
// (CommonMark §4.2: 最大 6、#の直後は必ず空白が必要)
const ATX_HEADING_RE = /^(#{1,6})[ \t]+(.+?)(?:\s+#+\s*)?$/;

/**
 * コードフェンス・frontmatter を除外した「スキャン可能な行」の配列を返す。
 * scannableLines (extract.ts) と同じ走査ロジックを踏む。
 * ただし extract.ts の scannableLines はパッケージ非公開 (export されていない) ため、
 * 同等ロジックをここで実装する。返り値は「(行文字列 | null)」の配列で、
 * null はフェンス内・frontmatter 内の行を示す。
 */
function scannableLines(content: string): (string | null)[] {
  const parsed = parseNote(content);
  const lines = content.split('\n');
  const bodyLines = parsed.body.split('\n');
  // frontmatter の行数分だけ offset が入る
  const bodyStart = lines.length - bodyLines.length;

  const result: (string | null)[] = new Array<string | null>(lines.length).fill(null);
  let inFence = false;
  let fenceMarker = '';
  const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = FENCE_RE.exec(line);
    if (fence && fence[2]) {
      const marker = fence[2][0] ?? '`';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        continue; // フェンス開始行は除外
      }
      if (marker === fenceMarker) {
        inFence = false;
        continue; // フェンス終了行は除外
      }
      // フェンス内の別種マーカーはただの本文
    }
    if (inFence) continue;
    result[i] = line;
  }
  return result;
}

/**
 * ノートから ATX 見出しを抽出する。
 * frontmatter・コードフェンス内は対象外。
 */
export function extractHeadings(content: string): NoteHeading[] {
  const scannable = scannableLines(content);
  const out: NoteHeading[] = [];
  for (let i = 0; i < scannable.length; i++) {
    const line = scannable[i];
    if (line === null || line === undefined) continue;
    const m = ATX_HEADING_RE.exec(line);
    if (m === null) continue;
    const hashes = m[1] ?? '';
    const text = (m[2] ?? '').trim();
    if (text.length === 0) continue;
    out.push({ level: hashes.length, text, line: i + 1 });
  }
  return out;
}

// CJK 文字クラス: Han + Hiragana + Katakana + Hangul
// (個人用ノートアプリで日本語・中国語・韓国語を主な対象とする)
const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu;

/**
 * ワード数・文字数を計算する。
 *
 * wordCount ルール:
 * - frontmatter と code-fence を除外した本文テキストを対象にする
 * - 空白で分割した非空トークンの数を基本とし、
 *   CJK 文字はそれぞれ 1 ワードとして別途カウントし、
 *   CJK 文字を含むトークンからは CJK 文字を除いた残りをトークンとして扱う
 *   (例: "hello世界" → "hello" 1 ワード + "世" "界" 2 ワード = 3)
 *
 * charCount:
 * - 除外済み本文テキスト全体の Unicode コードポイント数
 *   (スペース・改行を含む)
 */
export function countWords(content: string): { wordCount: number; charCount: number } {
  const scannable = scannableLines(content);
  // スキャン対象の行だけ結合する (非スキャン行 = null は空行相当として \n で代替)
  const bodyText = scannable.map((l) => (l === null ? '' : l)).join('\n');

  // charCount: Unicode コードポイント数 (スプレッド展開でサロゲートペアを 1 文字として扱う)
  const charCount = [...bodyText].length;

  // wordCount: CJK を 1 文字 = 1 ワードとする方式
  let wordCount = 0;
  const tokens = bodyText.split(/\s+/);
  for (const token of tokens) {
    if (token.length === 0) continue;
    // CJK 文字を数える
    const cjkMatches = token.match(CJK_RE);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    wordCount += cjkCount;
    // CJK を除いた残りが空でなければ +1
    const remainder = token.replace(CJK_RE, '');
    if (remainder.length > 0) wordCount += 1;
  }

  return { wordCount, charCount };
}

/**
 * ノートのアウトゴーイングリンクを集約する。
 * - 同一ターゲット (NFC 正規化) の重複を除去する
 * - resolvedPath は vaultPaths から resolveLinkTarget で解決する
 * - raw は最初に出現したリンクのテキストを採用する
 */
export function extractOutgoingLinks(
  content: string,
  vaultPaths: Iterable<string>,
  resolveLinkTarget: (target: string, paths: Iterable<string>) => string | null,
): OutgoingLink[] {
  const pathArr = [...vaultPaths];
  const links = extractLinks(content);
  const seen = new Map<string, OutgoingLink>();
  for (const link of links) {
    const key = link.target.normalize('NFC');
    if (seen.has(key)) continue;
    const resolvedPath = resolveLinkTarget(key, pathArr);
    seen.set(key, { target: key, resolvedPath, raw: link.raw });
  }
  return [...seen.values()];
}

/**
 * ノートのタグを抽出する (インライン #tag + frontmatter tags の統合)。
 * extractTags の薄いラッパー (タグ抽出ロジックは extract.ts に集中)。
 */
export function extractNoteMetaTags(content: string): string[] {
  return extractTags(content);
}
