/**
 * 汎用テンプレートの変数エンジンと日付フォーマット (S89a350-1)。
 *
 * server / cli / ui が共有する。テンプレート記法 (`{{...}}`) を解決して
 * ピュア Markdown 文字列を生成するための純関数群。任意コード評価 (eval) は
 * 一切行わない — 既知トークンの単純置換のみ (DESIGN_PRINCIPLES priority 2)。
 *
 * サポートする記法:
 *   {{name}}          … ユーザー変数 name の値で置換 (未定義は missing に収集)
 *   {{date:FORMAT}}   … 基準日 (既定=now) を FORMAT で整形
 *   {{now:FORMAT}}    … 基準時刻 (既定=現在時刻) を FORMAT で整形
 *
 * FORMAT トークン (サーバーローカル時刻の暦成分・0 詰め):
 *   YYYY 年 / MM 月 / DD 日 / HH 時 / mm 分 / ss 秒
 *   `{{date:YYYY-MM-DD}}` は既存 journalPath (journal.ts) と同一文字列を再現する。
 *
 * 将来拡張の穴 (本スプリントでは未実装): 曜日トークン・日付オフセット。
 * formatDate に token map を追加するだけで拡張できるよう分離してある。
 */

/** {{date:...}} / {{now:...}} の基準日時を注入するコンテキスト。 */
export interface TemplateContext {
  /** ユーザー変数マップ (name → 値)。キー自体が無い変数は missing に収集される。 */
  vars?: Record<string, string>;
  /** {{date:FORMAT}} の基準日。journal は対象日を渡す。既定は new Date()。 */
  date?: Date;
  /** {{now:FORMAT}} の基準時刻。既定は new Date()。 */
  now?: Date;
  /**
   * パス用途フラグ。true のとき変数値を sanitizePathValue で無害化してから
   * 展開する (保存先パターンの解決に使う)。本文解決では false (値は verbatim)。
   */
  pathMode?: boolean;
}

/** テンプレート解決結果。 */
export interface TemplateResolveResult {
  /** 解決後テキスト (未定義変数トークンは verbatim のまま残る)。 */
  text: string;
  /** 参照されているが vars に存在しない変数名 (出現順・重複排除)。 */
  missing: string[];
}

const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const DATE_FORMAT_TOKEN_RE = /YYYY|MM|DD|HH|mm|ss/g;
/** 制御文字 (C0 + DEL)。パスや値から除去する。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 日付/時刻を FORMAT トークンで整形する。サーバーローカル時刻の暦成分を使う。
 * `formatDate('YYYY-MM-DD', d)` は todayJournalDate(d) と同一文字列になる。
 */
export function formatDate(format: string, base: Date = new Date()): string {
  const tokens: Record<string, () => string> = {
    YYYY: () => String(base.getFullYear()).padStart(4, '0'),
    MM: () => pad2(base.getMonth() + 1),
    DD: () => pad2(base.getDate()),
    HH: () => pad2(base.getHours()),
    mm: () => pad2(base.getMinutes()),
    ss: () => pad2(base.getSeconds()),
  };
  return format.replace(DATE_FORMAT_TOKEN_RE, (m) => {
    const fn = tokens[m];
    return fn !== undefined ? fn() : m;
  });
}

/**
 * パス用途の変数値を無害化する (AC-S89a350-1-3)。
 * - NFC 正規化
 * - 制御文字を除去
 * - パス区切り (`/` `\`) を除去 (1 セグメント内に閉じ込める)
 * - `..` (2 個以上連続のドット) を単一ドットに潰す (traversal 除去)
 * - 先頭・末尾のドット/空白を除去 (隠しセグメント化・空セグメント化を防ぐ)
 *
 * 展開後の最終パスは呼び出し側で必ず normalizeVaultPath に通すこと。
 */
export function sanitizePathValue(value: string): string {
  return value
    .normalize('NFC')
    .replace(CONTROL_CHARS_RE, '')
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

/** トークン内容がプリセット (date:/now:) なら整形結果を、そうでなければ null。 */
function resolvePreset(inner: string, ctx: TemplateContext): string | null {
  const colon = inner.indexOf(':');
  if (colon === -1) return null;
  const kind = inner.slice(0, colon).trim();
  if (kind !== 'date' && kind !== 'now') return null;
  const format = inner.slice(colon + 1).trim();
  const base = kind === 'date' ? (ctx.date ?? ctx.now ?? new Date()) : (ctx.now ?? new Date());
  return formatDate(format, base);
}

/**
 * テンプレート文字列の `{{...}}` を解決する。
 * プリセット (date/now) は常に解決され、ユーザー変数は vars で置換する。
 * vars にキーが無い変数は text に verbatim 残し、名前を missing に収集する。
 */
export function resolveTemplate(
  text: string,
  ctx: TemplateContext = {},
): TemplateResolveResult {
  const vars = ctx.vars ?? {};
  const missingSet = new Set<string>();
  const missing: string[] = [];

  const out = text.replace(TOKEN_RE, (whole, rawInner: string) => {
    const inner = rawInner.trim();
    if (inner === '') return whole; // `{{}}` は記法ではない — verbatim
    const preset = resolvePreset(inner, ctx);
    if (preset !== null) return preset;
    // ユーザー変数
    if (Object.prototype.hasOwnProperty.call(vars, inner)) {
      const value = vars[inner] ?? '';
      return ctx.pathMode === true ? sanitizePathValue(value) : value;
    }
    if (!missingSet.has(inner)) {
      missingSet.add(inner);
      missing.push(inner);
    }
    return whole; // 未定義は verbatim (呼び出し側が missing で弾く)
  });

  return { text: out, missing };
}

/** テンプレート文字列が参照している全変数名 (プリセット除く・出現順・重複排除)。 */
export function templateVariableNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const inner = (m[1] ?? '').trim();
    if (inner === '') continue;
    const colon = inner.indexOf(':');
    if (colon !== -1) {
      const kind = inner.slice(0, colon).trim();
      if (kind === 'date' || kind === 'now') continue;
    }
    if (!seen.has(inner)) {
      seen.add(inner);
      names.push(inner);
    }
  }
  return names;
}
