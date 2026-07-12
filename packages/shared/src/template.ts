/**
 * 汎用テンプレートの変数エンジンと日付フォーマット (S89a350-1, Sf2f114-1)。
 *
 * server / cli / ui が共有する。テンプレート記法 (`{{...}}`) を解決して
 * ピュア Markdown 文字列を生成するための純関数群。任意コード評価 (eval) は
 * 一切行わない — 既知トークンの単純置換のみ (DESIGN_PRINCIPLES priority 2)。
 *
 * サポートする記法:
 *   {{name}}              … ユーザー変数 name の値で置換 (未定義は missing に収集)
 *   {{name|fallback}}     … param が未定義または空文字のとき fallback を使用 (Sf2f114-1)
 *   {{date:FORMAT}}       … 基準日 (既定=now) を FORMAT で整形
 *   {{now:FORMAT}}        … 基準時刻 (既定=現在時刻) を FORMAT で整形
 *   {{date:+Nd:FORMAT}}   … 基準日 +N 日のオフセットを FORMAT で整形 (Sf2f114-1)
 *   {{date:-Nd:FORMAT}}   … 基準日 -N 日のオフセットを FORMAT で整形 (Sf2f114-1)
 *   {{now:+Nd:FORMAT}}    … 現在時刻 +N 日のオフセットを FORMAT で整形 (Sf2f114-1)
 *
 * FORMAT トークン (サーバーローカル時刻の暦成分・0 詰め):
 *   YYYY 年 / MM 月 / DD 日 / HH 時 / mm 分 / ss 秒
 *   `{{date:YYYY-MM-DD}}` は既存 journalPath (journal.ts) と同一文字列を再現する。
 *
 * オフセット記法の注意:
 *   - 日単位 (d) のみサポート。他の単位 (h, m, w など) は非サポートで verbatim 残り。
 *   - `|` はパイプ fallback の区切りとして予約。値内のリテラル `|` は非サポート。
 *   - `|` は最初の出現で分割する (fallback 内に `|` を含む場合は最初の `|` まで)。
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

/**
 * 日付オフセット記法 (+Nd / -Nd) のマッチ。
 * 先頭が `+` または `-` で始まり、数字の後に `d` が続く場合のみ有効。
 * 他の単位 (h, m, w など) はマッチしない。
 */
const DAY_OFFSET_RE = /^([+-])(\d+)d$/;

/**
 * ベース日時に日数オフセットを適用した新しい Date を返す。
 * ローカル時刻の日付成分だけをずらす (時刻・タイムゾーンは保持)。
 */
function applyDayOffset(base: Date, offsetStr: string): Date | null {
  const m = DAY_OFFSET_RE.exec(offsetStr);
  if (m === null) return null;
  const sign = m[1] === '+' ? 1 : -1;
  const days = parseInt(m[2] ?? '0', 10);
  const result = new Date(base.getTime());
  result.setDate(result.getDate() + sign * days);
  return result;
}

/**
 * トークン内容がプリセット (date:/now:) なら整形結果を、そうでなければ null。
 *
 * 拡張 (Sf2f114-1): `date:+Nd:FORMAT` / `date:-Nd:FORMAT` の相対日付オフセットをサポート。
 * - 2 番目の `:` の前がオフセット記法 (+Nd/-Nd) なら日付をずらして整形する。
 * - オフセット記法でない場合 (既存の `date:FORMAT` など) は従来通り。
 * - `d` 以外の単位を含むオフセット記法は null を返し verbatim 扱いにする。
 */
function resolvePreset(inner: string, ctx: TemplateContext): string | null {
  const colon = inner.indexOf(':');
  if (colon === -1) return null;
  const kind = inner.slice(0, colon).trim();
  if (kind !== 'date' && kind !== 'now') return null;
  const rest = inner.slice(colon + 1).trim();
  const base = kind === 'date' ? (ctx.date ?? ctx.now ?? new Date()) : (ctx.now ?? new Date());

  // 相対日付オフセットの検出: rest が `+Nd:FORMAT` または `-Nd:FORMAT` の形か確認
  const secondColon = rest.indexOf(':');
  if (secondColon !== -1) {
    const offsetPart = rest.slice(0, secondColon).trim();
    const formatPart = rest.slice(secondColon + 1).trim();
    // オフセット記法として有効か試みる
    if (DAY_OFFSET_RE.test(offsetPart)) {
      const shifted = applyDayOffset(base, offsetPart);
      if (shifted !== null) {
        return formatDate(formatPart, shifted);
      }
      // applyDayOffset は DAY_OFFSET_RE.test が true なら null を返さないが念のため
      return null;
    }
    // secondColon があっても offsetPart が +Nd/-Nd でなければ従来通り (format にコロンが含まれる等)
  }

  // 従来の `date:FORMAT` / `now:FORMAT` 処理
  return formatDate(rest, base);
}

/**
 * テンプレート文字列の `{{...}}` を解決する。
 * プリセット (date/now) は常に解決され、ユーザー変数は vars で置換する。
 * vars にキーが無い変数は text に verbatim 残し、名前を missing に収集する。
 *
 * 拡張 (Sf2f114-1):
 * - `{{param|fallback}}` — param が未定義または空文字のとき fallback を使用。
 *   パイプ付きで fallback が使われた場合は missing に収集しない。
 *   パイプなし `{{param}}` の動作は変更なし (未定義 → verbatim + missing)。
 * - `{{date:+Nd:FMT}}` / `{{date:-Nd:FMT}}` — 相対日付オフセット (resolvePreset 参照)。
 *
 * トークン解析の優先順位:
 *   1. `{{}}` (空) → verbatim (記法として扱わない)
 *   2. プリセット判定: `date:` / `now:` で始まる → resolvePreset (相対日付含む)
 *   3. パイプ分割: `|` を含む → `{{varName|fallback}}` 形式として処理
 *   4. 通常ユーザー変数: vars に存在 → 値を展開; 存在しない → verbatim + missing
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

    // 優先順位 2: プリセット (date:/now:)
    const preset = resolvePreset(inner, ctx);
    if (preset !== null) return preset;

    // 優先順位 3: パイプ付きフォールバック `{{param|fallback}}`
    const pipeIdx = inner.indexOf('|');
    if (pipeIdx !== -1) {
      const varName = inner.slice(0, pipeIdx).trim();
      const fallback = inner.slice(pipeIdx + 1); // fallback はリテラル (trim しない)
      const rawValue = Object.prototype.hasOwnProperty.call(vars, varName)
        ? (vars[varName] ?? '')
        : undefined;
      if (rawValue === undefined || rawValue === '') {
        // 未定義または空文字 → fallback を使用 (missing に収集しない)
        return ctx.pathMode === true ? sanitizePathValue(fallback) : fallback;
      }
      return ctx.pathMode === true ? sanitizePathValue(rawValue) : rawValue;
    }

    // 優先順位 4: 通常ユーザー変数
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

/**
 * テンプレート文字列が参照している全変数名 (プリセット除く・出現順・重複排除)。
 * パイプ付き `{{param|fallback}}` の場合は変数名部分 (param) を返す。
 */
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
    // パイプ付きの場合は変数名部分だけを取り出す
    const pipeIdx = inner.indexOf('|');
    const varName = pipeIdx !== -1 ? inner.slice(0, pipeIdx).trim() : inner;
    if (!seen.has(varName)) {
      seen.add(varName);
      names.push(varName);
    }
  }
  return names;
}
