/**
 * テンプレートファイル (templates/ 配下のピュア Markdown) の構造解析 (S89a350 / S67ea41)。
 *
 * テンプレートの正本は templates/ 配下のピュア Markdown。設定はフロントマターの単一キー
 * `loamium-template`(target: 保存先パターン / vars: 変数定義 / description)に格納する。
 * loamium-template 以外のフロントマター + 本文が「結果ノートのテンプレート本体」になり、
 * instantiate / journal 遅延生成の際に loamium-template ブロックを行範囲で verbatim 除去して
 * から変数解決する。結果は常にピュア Markdown(テンプレート記法 `{{...}}` は残さない —
 * DESIGN_PRINCIPLES priority 1)。
 *
 * このモジュールは server の templates ルートと journal ルートで共有する(重複排除)。
 * 壊れた loamium-template(型不一致)はクラッシュせず純粋雛形(target なし)へフォールバックする。
 */
import { parseNote } from './markdown.js';
import { resolveTemplate, templateVariableNames, type TemplateContext } from './template.js';
import type { TemplateVar, TemplateVarType } from './schemas.js';

const VAR_TYPES: readonly TemplateVarType[] = ['text', 'select', 'date', 'tags'];

export interface TemplateConfig {
  /** 保存先パターン(未指定は null)。 */
  target: string | null;
  /** 人間向け説明。 */
  description?: string;
  /** 宣言済み変数(不正要素は除外済み)。 */
  vars: TemplateVar[];
}

/** loamium-template.vars の 1 要素を寛容に正規化する(不正は null で捨てる)。 */
export function normalizeVar(raw: unknown): TemplateVar | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (name === '') return null;
  const t = o.type;
  const type: TemplateVarType =
    typeof t === 'string' && (VAR_TYPES as readonly string[]).includes(t)
      ? (t as TemplateVarType)
      : 'text';
  const v: TemplateVar = { name, type, required: o.required === true };
  if (typeof o.label === 'string') v.label = o.label;
  if (typeof o.default === 'string') v.default = o.default;
  else if (typeof o.default === 'number' || typeof o.default === 'boolean') {
    v.default = String(o.default);
  }
  if (Array.isArray(o.options)) {
    const opts = o.options.filter((x): x is string => typeof x === 'string');
    if (opts.length > 0) v.options = opts;
  }
  if (typeof o.optionsQuery === 'string' && o.optionsQuery.trim() !== '') {
    v.optionsQuery = o.optionsQuery;
  }
  return v;
}

/** frontmatter から loamium-template 設定を寛容に取り出す(壊れは純粋雛形へフォールバック)。 */
export function parseTemplateConfig(frontmatter: Record<string, unknown> | null): TemplateConfig {
  const empty: TemplateConfig = { target: null, vars: [] };
  if (frontmatter === null) return empty;
  const raw = frontmatter['loamium-template'];
  if (raw === undefined) return empty; // 他フロントマターだけを持つ純粋雛形
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty; // 壊れ → フォールバック
  const o = raw as Record<string, unknown>;
  const cfg: TemplateConfig = {
    target: typeof o.target === 'string' && o.target.trim() !== '' ? o.target : null,
    vars: [],
  };
  if (typeof o.description === 'string') cfg.description = o.description;
  if (Array.isArray(o.vars)) {
    for (const rv of o.vars) {
      const v = normalizeVar(rv);
      if (v !== null) cfg.vars.push(v);
    }
  }
  return cfg;
}

/** 生ノートを (frontmatter 行配列, 本文) に分ける(parseNote と同じ境界判定)。 */
function splitRaw(content: string): { fmLines: string[] | null; body: string } {
  if (!/^---(?:\r?\n)/.test(content)) return { fmLines: null, body: content };
  const lines = content.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').replace(/\r$/, '') === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { fmLines: null, body: content };
  const fmLines = lines.slice(1, close).map((l) => l.replace(/\r$/, ''));
  const body = lines.slice(close + 1).join('\n');
  return { fmLines, body };
}

/** frontmatter 行から loamium-template のトップレベルキーブロックを verbatim 除去する。 */
function stripConfigLines(fmLines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i] ?? '';
    if (/^loamium-template\s*:/.test(line)) {
      i++;
      // 続くインデント行・空行(このキーの配下)を読み飛ばす
      while (i < fmLines.length) {
        const next = fmLines[i] ?? '';
        if (next.trim() === '' || /^\s/.test(next)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out;
}

/**
 * テンプレートファイルの内容から「結果ノートのテンプレート本体」を組み立てる。
 * loamium-template ブロックを除いた残りフロントマター + 本文。残りが空なら本文のみ。
 */
export function buildBodyTemplate(content: string): string {
  const { fmLines, body } = splitRaw(content);
  if (fmLines === null) return content; // frontmatter 無し = 全体が本文テンプレート
  const remaining = stripConfigLines(fmLines);
  while (remaining.length > 0 && (remaining[0] ?? '').trim() === '') remaining.shift();
  while (remaining.length > 0 && (remaining[remaining.length - 1] ?? '').trim() === '') {
    remaining.pop();
  }
  if (remaining.length === 0) return body;
  return `---\n${remaining.join('\n')}\n---\n${body}`;
}

/**
 * 遅延生成 journal 向けにテンプレート本文を解決する (S67ea41-1)。
 *
 * instantiate と違い、対話的な変数入力(作成モーダル)が無いため:
 *   - `{{date:...}}` / `{{now:...}}` は ctx の対象日時基準で展開する
 *   - 宣言済み変数(loamium-template.vars)は default があればそれを解決して使う
 *   - 参照されているが default の無い変数は空文字で解決する
 * これにより結果は必ず解決済みピュア Markdown(`{{...}}` 非残存)になる
 * (DESIGN_PRINCIPLES priority 1)。ctx.date は journal の対象日を渡す。
 */
export function applyJournalTemplate(
  templateContent: string,
  ctx: { date: Date; now: Date },
): string {
  const cfg = parseTemplateConfig(parseNote(templateContent).frontmatter);
  const bodyTemplate = buildBodyTemplate(templateContent);

  // 参照される全変数を空文字で初期化 → default があれば上書き(対象日基準で解決)。
  const vars: Record<string, string> = {};
  for (const name of templateVariableNames(bodyTemplate)) vars[name] = '';
  for (const def of cfg.vars) {
    if (def.default !== undefined) {
      vars[def.name] = resolveTemplate(def.default, { date: ctx.date, now: ctx.now }).text;
    }
  }

  const resolveCtx: TemplateContext = { vars, date: ctx.date, now: ctx.now };
  return resolveTemplate(bodyTemplate, resolveCtx).text;
}
