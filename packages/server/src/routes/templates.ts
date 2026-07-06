/**
 * 汎用テンプレートエンドポイント (S89a350-2)。
 *
 * - GET  /api/templates                       vault 内可視 templates/ 配下の *.md 一覧
 * - POST /api/templates/{name}/instantiate     target/本文を解決して新規ノート作成
 *
 * テンプレートの正本は templates/ 配下のピュア Markdown。設定はフロントマターの
 * 単一キー `loamium-template`(target: 保存先パターン / vars: 変数定義 / description)。
 * loamium-template 以外のフロントマター + 本文が結果ノートのテンプレート本体になり、
 * instantiate 時に loamium-template ブロックを除去してから変数解決する。
 * 結果ノートはピュア Markdown(テンプレート記法は一切残らない — DESIGN_PRINCIPLES priority 1)。
 *
 * 壊れた loamium-template(型不一致)はクラッシュせず純粋雛形(target なし)へフォールバック。
 * 変数値のパスサニタイズ + normalizeVaultPath 通過は shared のエンジンが担う(priority 2)。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  isValidJournalDate,
  normalizeVaultPath,
  parseNote,
  resolveTemplate,
  templateInstantiateRequestSchema,
  VaultPathError,
  type TemplateInstantiateResponse,
  type TemplateMissingVarsResponse,
  type TemplateSummary,
  type TemplatesResponse,
  type TemplateVar,
  type TemplateVarType,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { listNoteFiles, noteMtime, readNote, writeNote } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';

const TEMPLATES_DIR = 'templates';
const TEMPLATES_PREFIX = `${TEMPLATES_DIR}/`;
const INSTANTIATE_PREFIX = '/api/templates/';
const VAR_TYPES: readonly TemplateVarType[] = ['text', 'select', 'date', 'tags'];

interface TemplateConfig {
  target: string | null;
  description?: string;
  vars: TemplateVar[];
}

/** loamium-template.vars の 1 要素を寛容に正規化する(不正は null で捨てる)。 */
function normalizeVar(raw: unknown): TemplateVar | null {
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
  return v;
}

/** frontmatter から loamium-template 設定を寛容に取り出す(壊れは純粋雛形へフォールバック)。 */
function parseConfig(frontmatter: Record<string, unknown> | null): TemplateConfig {
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
function buildBodyTemplate(content: string): string {
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

function summaryFor(rel: string, content: string): TemplateSummary {
  const cfg = parseConfig(parseNote(content).frontmatter);
  const name = rel.slice(TEMPLATES_PREFIX.length).replace(/\.md$/i, '');
  const summary: TemplateSummary = { name, path: rel, target: cfg.target, vars: cfg.vars };
  if (cfg.description !== undefined) summary.description = cfg.description;
  return summary;
}

/** vault 相対パスに連番 (_2, _3, ...) を付けて最初の空きパスを返す。 */
async function firstFreePath(vaultRoot: string, rel: string): Promise<string> {
  if ((await noteMtime(vaultRoot, rel)) === null) return rel;
  const dot = rel.toLowerCase().lastIndexOf('.md');
  const stem = dot === -1 ? rel : rel.slice(0, dot);
  const ext = dot === -1 ? '' : rel.slice(dot);
  for (let n = 2; n <= 9999; n++) {
    const candidate = `${stem}_${String(n)}${ext}`;
    if ((await noteMtime(vaultRoot, candidate)) === null) return candidate;
  }
  throw new Error(`no free path for ${rel} (suffix _2.._9999 all taken)`);
}

/** URL パスから {name} を取り出して templates/{name}.md へ正規化する。 */
function templatePathFrom(rawPath: string): string {
  const rest = rawPath.slice(INSTANTIATE_PREFIX.length);
  const suffix = '/instantiate';
  if (!rest.endsWith(suffix)) {
    throw new VaultPathError('POST /api/templates/{name}/instantiate のみサポートしています');
  }
  const encodedName = rest.slice(0, rest.length - suffix.length);
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new VaultPathError('template name is not valid percent-encoding');
  }
  if (name === '') throw new VaultPathError('template name is missing');
  return normalizeVaultPath(`${TEMPLATES_DIR}/${name}`);
}

export function templatesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/templates', async (c) => {
    const all = await listNoteFiles(config.vaultRoot);
    const templates: TemplateSummary[] = [];
    for (const rel of all) {
      if (!rel.startsWith(TEMPLATES_PREFIX)) continue;
      const content = await readNote(config.vaultRoot, rel);
      if (content === null) continue; // 走査後に消えたファイル
      try {
        templates.push(summaryFor(rel, content));
      } catch (err) {
        // 壊れた 1 件で一覧全体を落とさない(priority 2 — クラッシュしない)
        console.error(`[loamium] skipping broken template ${rel}:`, err);
      }
    }
    const res: TemplatesResponse = { templates };
    return c.json(res);
  });

  app.post('/api/templates/*', async (c) => {
    let rel: string;
    try {
      rel = templatePathFrom(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }

    const content = await readNote(config.vaultRoot, rel);
    if (content === null) {
      return errorJson(c, 404, 'template_not_found', `template not found: ${rel}`);
    }

    const body = await parseBody(c, templateInstantiateRequestSchema);
    if (!body.ok) return body.response;

    // 基準日: date 指定があれば {{date:...}} の基準日を上書き(YYYY-MM-DD)。
    const now = new Date();
    let dateBase = now;
    if (body.data.date !== undefined) {
      if (!isValidJournalDate(body.data.date)) {
        return errorJson(
          c,
          400,
          'invalid_date',
          `invalid date: "${body.data.date}" (expected YYYY-MM-DD)`,
        );
      }
      const [y, m, d] = body.data.date.split('-').map(Number);
      dateBase = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
    }

    const cfg = parseConfig(parseNote(content).frontmatter);

    // 宣言済み変数をマージする。default があれば解決値、無ければ空文字で初期化し
    // (任意変数の未入力を missing 扱いにしない)、リクエスト値で上書きする。
    const vars: Record<string, string> = {};
    for (const def of cfg.vars) {
      vars[def.name] =
        def.default !== undefined
          ? resolveTemplate(def.default, { date: dateBase, now }).text
          : '';
    }
    for (const [k, v] of Object.entries(body.data.vars)) vars[k] = v;

    // 必須未入力(空値含む)を検出
    const missingRequired: string[] = [];
    for (const def of cfg.vars) {
      if (def.required && (vars[def.name] ?? '').trim() === '') missingRequired.push(def.name);
    }

    // target(保存先)を pathMode で解決し、本文を verbatim で解決する。
    const targetPattern =
      cfg.target ?? rel.slice(TEMPLATES_PREFIX.length).replace(/\.md$/i, '');
    const targetRes = resolveTemplate(targetPattern, { vars, date: dateBase, now, pathMode: true });
    const bodyTemplate = buildBodyTemplate(content);
    const bodyRes = resolveTemplate(bodyTemplate, { vars, date: dateBase, now });

    // 不足変数(参照されているが未指定 + 必須未入力)を集約
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const name of [...missingRequired, ...targetRes.missing, ...bodyRes.missing]) {
      if (!seen.has(name)) {
        seen.add(name);
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      const res: TemplateMissingVarsResponse = {
        error: 'missing_vars',
        message: `missing required variables: ${missing.join(', ')}`,
        missing,
      };
      return c.json(res, 400);
    }

    // 展開結果を vault パスへ正規化(traversal 等はサニタイズ済みだが二重に検証)
    let destRaw: string;
    try {
      destRaw = normalizeVaultPath(targetRes.text);
    } catch (err) {
      if (err instanceof VaultPathError) {
        return errorJson(
          c,
          400,
          'invalid_target',
          `resolved target is not a valid vault path: "${targetRes.text}" (${err.message})`,
        );
      }
      throw err;
    }

    const dest = await firstFreePath(config.vaultRoot, destRaw);
    setAudit(c, 'template.instantiate', dest);
    await writeNote(config.vaultRoot, dest, bodyRes.text);
    const res: TemplateInstantiateResponse = { path: dest, created: true };
    return c.json(res, 201);
  });

  return app;
}
