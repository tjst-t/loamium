/**
 * frontmatter プロパティモデル — WYSIWYG プロパティ UI の直列化基盤 (S9df823-1)。
 *
 * parseNote (markdown.ts) と同じ yaml パッケージで frontmatter を
 * 「編集可能なプロパティの列」へ分解し、標準 YAML へ直列化して書き戻す。
 * 正本は常に Markdown 文字列 1 本 (DESIGN_PRINCIPLES priority 1) — 本モジュールは
 * 表示層のためのモデル変換のみを担い、独自記法・不可視文字を一切導入しない。
 *
 * 設計方針 (docs/sprint-logs/S9df823/decisions.json P-2〜P-4):
 * - WYSIWYG 編集できるのはスカラー (文字列・数値・真偽・null) とフラットな
 *   スカラー配列だけ。ネスト・複数行文字列・引用符付きキー等は complex として
 *   原文行を verbatim 保持し、読み取り専用 (編集はソースへ誘導)。
 * - 未編集エントリは元のソース行をそのまま再出力する (勝手に整形しない)。
 * - 少しでも解釈に自信が持てない frontmatter は null を返して widget を諦める
 *   (生ソース表示のまま = ファイルは壊れない)。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** WYSIWYG 編集対象のスカラー値 (日付らしき文字列も文字列のまま扱う)。 */
export type PropScalar = string | number | boolean | null;

/** frontmatter の 1 エントリ。source はエントリが由来する原文行 (verbatim 再出力用)。 */
export type PropEntry =
  | { kind: 'scalar'; key: string; value: PropScalar; source?: string[] }
  | { kind: 'list'; key: string; items: PropScalar[]; source?: string[] }
  /** ネスト等の複雑な値 — 原文行を保持し読み取り専用 */
  | { kind: 'complex'; key: string; source: string[] }
  /** トップレベルのコメント行・空行 — 表示しないが verbatim 保持する */
  | { kind: 'raw'; source: string[] };

/** 編集可能なスカラーか (複数行文字列・非有限数は complex 扱い)。 */
function isEditableScalar(v: unknown): v is PropScalar {
  if (v === null) return true;
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return !v.includes('\n');
  return false;
}

/** JSON 値としての deep equal (yaml パース結果同士の比較用)。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

/**
 * トップレベルのキー行 (`key:` / `"key":` / `'key':`) を検出する。
 * plain キーは `:` を含められない (含む場合はマッチせず → フォールバック)。
 */
const KEY_LINE_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"-][^:]*?)\s*:(?=\s|$)/;

/**
 * YAML アンカー (&name) / エイリアス (*name) を値に含むエントリの検出。
 * 別エントリを参照し合うため、片方だけ再直列化すると壊れる → complex (読み取り専用)
 * に落とす。有効な YAML では plain scalar が & / * で始まることはないので誤検出しない。
 */
const ANCHOR_ALIAS_RE = /(?::\s+|-\s+)[&*]\S|^[&*]\S/;

function hasAnchorOrAlias(source: string[]): boolean {
  return source.some((l) => ANCHOR_ALIAS_RE.test(l.trim()) || ANCHOR_ALIAS_RE.test(l));
}

/** 引用符付きキーのトークンを実キー名へ解決する。解決不能なら null。 */
function resolveKeyToken(token: string): string | null {
  if (token.startsWith('"')) {
    try {
      const parsed: unknown = parseYaml(`${token}: 1`);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        return keys.length === 1 ? (keys[0] ?? null) : null;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (token.startsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  return token.trim();
}

/**
 * frontmatter の内側 YAML テキストをプロパティモデルへ分解する。
 *
 * 以下のいずれかに該当する場合は null (= WYSIWYG 不可、生ソース表示のまま):
 * - YAML が壊れている / トップレベルがオブジェクトでない / 空
 * - 行の切り分け結果が parseYaml のキー集合と一致しない (アンカー・マージ等)
 * - モデルを再直列化して読み戻した結果が元データと deep-equal でない
 */
export function parsePropertiesModel(yamlText: string): PropEntry[] | null {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  const lines = yamlText.split('\n');
  const entries: PropEntry[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // 末尾の join 由来の最終空行はスキップ (splitで生じるのは末尾のみ)
    if (line.trim() === '') {
      entries.push({ kind: 'raw', source: [line] });
      i++;
      continue;
    }
    if (line.startsWith('#')) {
      entries.push({ kind: 'raw', source: [line] });
      i++;
      continue;
    }
    if (/^\s/.test(line)) return null; // トップレベルに来ないはずの継続行
    const m = KEY_LINE_RE.exec(line);
    if (m === null) return null; // 認識できないトップレベル構造 (シーケンス等)
    const token = m[1] ?? '';
    const key = resolveKeyToken(token);
    if (key === null || seen.has(key) || !(key in obj)) return null;
    seen.add(key);

    // 継続行 (インデント行・空行) をこのエントリの原文として取り込む
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? '';
      if (next.trim() !== '' && !/^\s/.test(next)) break;
      j++;
    }
    // 末尾の空行はエントリに含めない (raw として独立させる)
    let end = j;
    while (end > i + 1 && (lines[end - 1] ?? '').trim() === '') end--;
    const source = lines.slice(i, end);
    i = end;

    const quotedKey = token.startsWith('"') || token.startsWith("'");
    const v = obj[key];
    if (quotedKey || hasAnchorOrAlias(source)) {
      // 引用符付きキー / アンカー・エイリアス入りは complex (読み取り専用・原文保持)
      entries.push({ kind: 'complex', key, source });
    } else if (isEditableScalar(v)) {
      entries.push({ kind: 'scalar', key, value: v, source });
    } else if (Array.isArray(v) && v.every(isEditableScalar)) {
      entries.push({ kind: 'list', key, items: v, source });
    } else {
      entries.push({ kind: 'complex', key, source });
    }
  }

  if (seen.size !== Object.keys(obj).length) return null;

  // 自己検証: モデルを直列化して読み戻し、元データと同値であることを確認する
  try {
    const back: unknown = parseYaml(serializeProperties(entries));
    if (!deepEqual(back, obj)) return null;
  } catch {
    return null;
  }

  return entries;
}

/** 1 エントリを標準 YAML 行へ直列化する (クオート判定は yaml パッケージに委ねる)。 */
function stringifyEntryLines(key: string, value: unknown): string[] {
  const text = stringifyYaml({ [key]: value }, { lineWidth: 0 });
  const lines = text.replace(/\n$/, '').split('\n');
  // null は Obsidian と同じ「値省略」形式 (`key:`) にする
  const first = lines[0] ?? '';
  if (value === null && lines.length === 1 && first.endsWith(': null')) {
    return [first.slice(0, -' null'.length)];
  }
  return lines;
}

/**
 * プロパティモデルを frontmatter の内側 YAML テキストへ直列化する。
 * 未編集エントリ (source あり) は原文 verbatim、編集済みは標準 YAML へ整形。
 * 戻り値は末尾に \n を持つ (空なら '')。
 */
export function serializeProperties(entries: PropEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.kind === 'raw' || e.kind === 'complex') {
      lines.push(...e.source);
    } else if (e.source !== undefined) {
      lines.push(...e.source);
    } else if (e.kind === 'scalar') {
      lines.push(...stringifyEntryLines(e.key, e.value));
    } else {
      lines.push(...stringifyEntryLines(e.key, e.items));
    }
  }
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

/** キー付きエントリ (scalar / list / complex) が 1 つでも残っているか。 */
export function hasKeyedProperties(entries: PropEntry[]): boolean {
  return entries.some((e) => e.kind !== 'raw');
}

/**
 * プロパティモデルを frontmatter ブロック文字列 (--- ... ---) へ直列化する。
 * キー付きエントリが 1 つも無ければ null (= ブロックごと除去せよ、の意)。
 */
export function serializeFrontmatterBlock(entries: PropEntry[]): string | null {
  if (!hasKeyedProperties(entries)) return null;
  return `---\n${serializeProperties(entries)}---`;
}

/**
 * 入力文字列の素朴な型解釈 (S9df823 P-8):
 * 空 → null / 'true'・'false' → 真偽 / 整数・小数 → 数値 / その他 → 文字列。
 */
export function parsePropInput(text: string): PropScalar {
  const t = text.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** 日付らしき文字列 (YYYY-MM-DD) か — UI が input[type=date] を出す判定に使う。 */
export function isDateLike(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
