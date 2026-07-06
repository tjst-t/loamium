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

/** 1 行内のインライン #tag の一致 (位置つき — 本文タグ装飾が使う)。 */
export interface InlineTagMatch {
  /** `#` の開始オフセット (行頭からの桁位置) */
  start: number;
  /** タグ末尾の次の位置 (`#` + タグ本体、末尾区切りは含まない) */
  end: number;
  /** タグ名 (`#` なし、NFC 正規化、末尾区切り除去済み) */
  tag: string;
}

/**
 * 1 行 (raw) からインライン #tag を位置つきで抽出する。
 * インラインコード (`...`) 内は無効化してから走査するため、抽出 (extractTags) と
 * 本文のタグ装飾 (live-preview) が同一の判定を共有できる。
 * 行頭 `# ` (直後スペース) の見出しは `#` の直後がタグ文字でないため一致しない。
 */
export function matchInlineTags(line: string): InlineTagMatch[] {
  const scan = blankInlineCode(line);
  const out: InlineTagMatch[] = [];
  for (const m of scan.matchAll(TAG_RE)) {
    const body = (m[2] ?? '').replace(/[/-]+$/, ''); // 末尾の区切り記号は落とす
    if (body.length === 0 || isNumericOnly(body)) continue;
    const lead = m[1] ?? ''; // 直前の区切り (行頭は '')
    const start = m.index + lead.length; // '#' の位置
    out.push({ start, end: start + 1 + body.length, tag: body.normalize('NFC') });
  }
  return out;
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
    for (const m of matchInlineTags(line)) add(m.tag);
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

// ---- タスク抽出 (Sb1593c-1) ------------------------------------------------------

export interface NoteTask {
  /** content 全体における 1 始まりの行番号 */
  line: number;
  /** チェックボックス以降のテキスト (trim 済み、無加工の表示用) */
  text: string;
  /** - [x] / - [X] なら true */
  checked: boolean;
  /** 行頭インデントの文字数 (ネスト判定用 — 4 スペース = 1 段が既定) */
  indent: number;
}

// Obsidian 互換タスク: リストマーカー (- * + / 1. / 1)) + [ ] / [x]。
// チェック文字は半角スペースか x/X のみ (プラグイン拡張の [-] 等は対象外)
const TASK_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s?(.*)$/;

/**
 * ノートからタスク行 (- [ ] / - [x]) を抽出する。
 * frontmatter・コードフェンス内は対象外 (タグ・リンク抽出と同じ走査規則)。
 * 正本は変更しない読み取り専用ビュー — インデックス (TASK クエリ) の入力を作る。
 */
export function extractTasks(content: string): NoteTask[] {
  const lines = content.split('\n');
  const scannable = scannableLines(content);
  const out: NoteTask[] = [];
  for (let i = 0; i < scannable.length; i++) {
    if (scannable[i] === null || scannable[i] === undefined) continue; // frontmatter / フェンス内
    // マッチはフェンス判定済みの原文行に対して行う (インラインコード空白化の影響を受けない)
    const m = TASK_RE.exec(lines[i] ?? '');
    if (m === null) continue;
    out.push({
      line: i + 1,
      text: (m[3] ?? '').trim(),
      checked: (m[2] ?? ' ').toLowerCase() === 'x',
      indent: (m[1] ?? '').length,
    });
  }
  return out;
}

/** ノートのタイトル (パスの basename から .md を除いたもの、NFC 正規化) */
export function noteTitle(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.md$/i, '').normalize('NFC');
}

export interface RewriteResult {
  /** 書き換え後の本文 (書き換えゼロなら元の content と同一文字列) */
  content: string;
  /** 書き換えたリンク数 */
  count: number;
}

/**
 * ノート本文の [[WikiLink]] ターゲットを書き換える (リネーム追従の心臓部)。
 *
 * - extractLinks と同じ走査規則: frontmatter・コードフェンス・インラインコード内は不変
 * - ターゲット部分 (最初の `#` / `|` より前) だけを置換し、
 *   `#見出し` / `#^block` / `|表示名` / 埋め込み `!` はそのまま保存する
 * - replace コールバックが null を返したリンクは変更しない
 *
 * @param content ノート本文 (ピュア Markdown)
 * @param replace NFC 正規化済みターゲットを受け取り、新ターゲット文字列
 *   (拡張子なし表記) を返す。書き換えないなら null。
 */
export function rewriteLinks(
  content: string,
  replace: (target: string) => string | null,
): RewriteResult {
  const lines = content.split('\n');
  const scannable = scannableLines(content);
  let count = 0;
  for (let i = 0; i < scannable.length; i++) {
    const blanked = scannable[i];
    if (blanked === null || blanked === undefined) continue;
    const original = lines[i] ?? '';
    // blanked 行でマッチ位置を求め、置換は同一オフセットの original に適用する
    // (インラインコードの空白化は行長・桁位置を保存している)
    let out = '';
    let cursor = 0;
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let changed = false;
    while ((m = LINK_RE.exec(blanked)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const originalSpan = original.slice(start, end);
      // blanked と original が食い違う (リンク風テキストに ` が混在する等の病的ケース) は触らない
      if (originalSpan !== m[0]) continue;
      const inner = m[2] ?? '';
      if (inner.trim().length === 0) continue;
      // ターゲット部分 = 最初の # / | より前。それ以降 (rest) は無加工で保存
      const hash = inner.indexOf('#');
      const pipe = inner.indexOf('|');
      const restIdx = hash === -1 ? pipe : pipe === -1 ? hash : Math.min(hash, pipe);
      const targetRaw = (restIdx === -1 ? inner : inner.slice(0, restIdx)).trim();
      if (targetRaw.length === 0) continue; // [[#heading]] 同一ノート内リンク
      const rest = restIdx === -1 ? '' : inner.slice(restIdx);
      const next = replace(targetRaw.normalize('NFC'));
      if (next === null) continue;
      const embed = m[1] ?? '';
      out += original.slice(cursor, start) + `${embed}[[${next}${rest}]]`;
      cursor = end;
      count += 1;
      changed = true;
    }
    if (changed) {
      lines[i] = out + original.slice(cursor);
    }
  }
  if (count === 0) return { content, count: 0 };
  return { content: lines.join('\n'), count };
}
