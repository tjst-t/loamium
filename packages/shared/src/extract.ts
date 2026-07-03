/**
 * タグ・[[WikiLink]] 抽出 — インデックス(検索・バックリンク・タグ)の入力を作る。
 *
 * 原則:
 * - 正本 (Markdown 文字列) は一切変更しない読み取り専用ビュー (DESIGN_PRINCIPLES priority 1)
 * - 記法は Obsidian 互換に限定 (priority 4)。独自記法は導入しない
 * - コードフェンス (``` / ~~~) 内とインラインコード (`...`) 内はタグ・リンクとも抽出しない
 */
import { parseNote } from './markdown.js';

export interface WikiLink {
  /** 元テキスト全体 (例: "[[note#見出し|別名]]") */
  raw: string;
  /** NFC 正規化済みのリンクターゲット (heading / block / alias を除いた部分) */
  target: string;
  /** #heading 部分 (無ければ null)。^block 参照は読み取り互換のみで heading とは区別する */
  heading: string | null;
  /** content 全体における 1 始まりの行番号 */
  line: number;
  /** リンクを含む行の元テキスト (コンテキスト表示用、無加工) */
  context: string;
  /** 埋め込み (![[...]]) かどうか */
  embed: boolean;
}

export interface NoteIndexEntry {
  /** タグ一覧 (NFC 正規化、"#" なし、重複除去、出現順) */
  tags: string[];
  /** 本文中の [[WikiLink]] 一覧 (出現順) */
  links: WikiLink[];
}

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;
const LINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;
// Obsidian 互換タグ: 英数字・_ - / と Unicode 文字。純数字のみは除外。
// \p{M} (結合文字) を含めるのは NFD 入力 (macOS 由来の濁点分解) を切り落とさないため。
// 直前は行頭・空白・一部の区切り文字のみ許可 ("a#b" や URL フラグメントを拾わない)
const TAG_RE = /(^|[\s(["'{>])#([\p{L}\p{M}\p{N}_/-]+)/gu;

/**
 * 1 行からインラインコード (`...`) スパンを同じ長さの空白に置き換える。
 * 行番号・桁位置を保ったままタグ・リンク検出だけを無効化する。
 */
function blankInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * content の各行について「スキャン可能な行」を返す。
 * - frontmatter ブロック内・コードフェンス内は null (スキャン対象外)
 * - インラインコードは空白化
 */
function scannableLines(content: string): (string | null)[] {
  const parsed = parseNote(content);
  const lines = content.split('\n');
  // frontmatter がある場合、本文開始行までをスキャン対象外にする
  const bodyLines = parsed.body.split('\n');
  const bodyStart = lines.length - bodyLines.length; // frontmatter の行数 (無ければ 0)

  const result: (string | null)[] = new Array<string | null>(lines.length).fill(null);
  let inFence = false;
  let fenceMarker = '';
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = FENCE_RE.exec(line);
    if (fence && fence[2]) {
      const marker = fence[2][0] ?? '`';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        continue;
      }
      if (marker === fenceMarker) {
        inFence = false;
        continue;
      }
      // フェンス内の別種マーカーはただの本文
    }
    if (inFence) continue;
    result[i] = blankInlineCode(line);
  }
  return result;
}

/**
 * frontmatter の tags 値を文字列配列に正規化する。
 * 配列 (tags: [a, b]) とカンマ/空白区切り文字列 (tags: a, b) の両方を認識 (Obsidian 互換)。
 */
export function frontmatterTags(frontmatter: Record<string, unknown> | null): string[] {
  if (frontmatter === null) return [];
  const raw = frontmatter['tags'] ?? frontmatter['tag'];
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const piece of v.split(/[,\s]+/)) {
        const t = piece.trim().replace(/^#/, '');
        if (t.length > 0) out.push(t.normalize('NFC'));
      }
    } else if (typeof v === 'number') {
      out.push(String(v));
    }
  };
  if (Array.isArray(raw)) {
    for (const v of raw) push(v);
  } else {
    push(raw);
  }
  return out;
}

/** 純数字タグ (Obsidian では無効) かどうか */
function isNumericOnly(tag: string): boolean {
  return /^[\p{N}]+$/u.test(tag);
}

/**
 * ノートからタグを抽出する。
 * インライン #tag (コードフェンス・インラインコード内は除外) と frontmatter tags の両方。
 * 返り値は NFC 正規化・"#" なし・出現順・重複除去 (大文字小文字はそのまま保持)。
 */
export function extractTags(content: string): string[] {
  const parsed = parseNote(content);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (tag: string): void => {
    const key = tag.normalize('NFC');
    const dedupe = key.toLowerCase();
    if (!seen.has(dedupe)) {
      seen.add(dedupe);
      out.push(key);
    }
  };

  for (const tag of frontmatterTags(parsed.frontmatter)) {
    if (!isNumericOnly(tag)) add(tag);
  }

  for (const line of scannableLines(content)) {
    if (line === null) continue;
    for (const m of line.matchAll(TAG_RE)) {
      const tag = (m[2] ?? '').replace(/[/-]+$/, ''); // 末尾の区切り記号は落とす
      if (tag.length === 0 || isNumericOnly(tag)) continue;
      add(tag);
    }
  }
  return out;
}

/**
 * ノート本文から [[WikiLink]] を抽出する (コードフェンス・インラインコード内は除外)。
 * frontmatter 内はリンクとして扱わない。
 */
export function extractLinks(content: string): WikiLink[] {
  const lines = content.split('\n');
  const out: WikiLink[] = [];
  const scannable = scannableLines(content);
  for (let i = 0; i < scannable.length; i++) {
    const line = scannable[i];
    if (line === null || line === undefined) continue;
    for (const m of line.matchAll(LINK_RE)) {
      const inner = (m[2] ?? '').trim();
      if (inner.length === 0) continue;
      // [[target#heading|alias]] → target / heading / alias
      const pipe = inner.indexOf('|');
      const targetAndSub = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const hash = targetAndSub.indexOf('#');
      const targetRaw = (hash === -1 ? targetAndSub : targetAndSub.slice(0, hash)).trim();
      const sub = hash === -1 ? '' : targetAndSub.slice(hash + 1).trim();
      // ^block 参照は heading ではない (読み取り互換のみ、生成もしない)
      const heading = sub.length > 0 && !sub.startsWith('^') ? sub.normalize('NFC') : null;
      // [[#heading]] のようなターゲット無しは同一ノート内リンク — バックリンク対象外
      if (targetRaw.length === 0) continue;
      out.push({
        raw: m[0],
        target: targetRaw.normalize('NFC'),
        heading,
        line: i + 1,
        context: lines[i] ?? '',
        embed: m[1] === '!',
      });
    }
  }
  return out;
}

/** ノートのタイトル (パスの basename から .md を除いたもの、NFC 正規化) */
export function noteTitle(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.md$/i, '').normalize('NFC');
}
