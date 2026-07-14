/**
 * 汎用テンプレートエンドポイント (S89a350-2, Sa10026-2-2)。
 *
 * POST-Sa10026-2 正本: system/templates/*.md (ADR-0010 amendment)
 *
 * - GET  /api/templates                       vault 内可視テンプレート一覧
 *                                              (system/templates/ を優先、fallback: templates/)
 * - POST /api/templates/{name}/instantiate     target/本文を解決して新規ノート作成
 *
 * テンプレートの正本は system/templates/ 配下のピュア Markdown。設定はフロントマターの
 * 単一キー `loamium-template`(target: 保存先パターン / vars: 変数定義 / description)。
 * loamium-template 以外のフロントマター + 本文が結果ノートのテンプレート本体になり、
 * instantiate 時に loamium-template ブロックを除去してから変数解決する。
 * 結果ノートはピュア Markdown(テンプレート記法は一切残らない — DESIGN_PRINCIPLES priority 1)。
 *
 * 後方互換:
 *   - system/templates/ にないテンプレートは templates/ からフォールバック読み込み。
 *   - instantiate の name は system/templates/{name}.md → templates/{name}.md の順に探す。
 *
 * 壊れた loamium-template(型不一致)はクラッシュせず純粋雛形(target なし)へフォールバック。
 * 変数値のパスサニタイズ + normalizeVaultPath 通過は shared のエンジンが担う(priority 2)。
 */
import { Hono } from 'hono';
import {
  buildBodyTemplate,
  isValidJournalDate,
  normalizeVaultPath,
  parseNote,
  parseTemplateConfig,
  resolveTemplate,
  templateInstantiateRequestSchema,
  VaultPathError,
  SYSTEM_TEMPLATES_DIR,
  type TemplateInstantiateResponse,
  type TemplateMissingVarsResponse,
  type TemplateSummary,
  type TemplatesResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { listNoteFiles, readNote, writeNote } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { firstFreePath } from '../vault-paths.js';

const TEMPLATES_DIR = 'templates';
const TEMPLATES_PREFIX = `${TEMPLATES_DIR}/`;
const SYSTEM_TEMPLATES_PREFIX = `${SYSTEM_TEMPLATES_DIR}/`;
const INSTANTIATE_PREFIX = '/api/templates/';

function summaryFor(rel: string, content: string): TemplateSummary {
  const cfg = parseTemplateConfig(parseNote(content).frontmatter);
  // name はどちらのパスプレフィックスも取り除いてから stem を返す
  let name: string;
  if (rel.startsWith(SYSTEM_TEMPLATES_PREFIX)) {
    name = rel.slice(SYSTEM_TEMPLATES_PREFIX.length).replace(/\.md$/i, '');
  } else {
    name = rel.slice(TEMPLATES_PREFIX.length).replace(/\.md$/i, '');
  }
  const summary: TemplateSummary = { name, path: rel, target: cfg.target, vars: cfg.vars };
  if (cfg.description !== undefined) summary.description = cfg.description;
  return summary;
}

/** URL パスから {name} を取り出す。 */
function nameFromInstantiatePath(rawPath: string): string {
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
  return name;
}

/**
 * テンプレートを解決する: system/templates/{name}.md → templates/{name}.md の順に探す。
 * [AC-Sa10026-2-2]: 旧パスの寛容 read フォールバック。
 */
async function resolveTemplatePath(
  vaultRoot: string,
  name: string,
): Promise<{ rel: string; content: string } | null> {
  // 1. system/templates/{name}.md を試みる
  const systemRel = normalizeVaultPath(`${SYSTEM_TEMPLATES_DIR}/${name}`);
  const systemContent = await readNote(vaultRoot, systemRel);
  if (systemContent !== null) {
    return { rel: systemRel, content: systemContent };
  }

  // 2. fallback: templates/{name}.md (旧パス後方互換)
  const legacyRel = normalizeVaultPath(`${TEMPLATES_DIR}/${name}`);
  const legacyContent = await readNote(vaultRoot, legacyRel);
  if (legacyContent !== null) {
    return { rel: legacyRel, content: legacyContent };
  }

  return null;
}

export function templatesRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/templates', async (c) => {
    const all = await listNoteFiles(config.vaultRoot);
    const templates: TemplateSummary[] = [];
    const seenNames = new Set<string>();

    for (const rel of all) {
      // system/templates/ を優先、次に templates/ (後方互換)
      const isSystem = rel.startsWith(SYSTEM_TEMPLATES_PREFIX);
      const isLegacy = rel.startsWith(TEMPLATES_PREFIX);
      if (!isSystem && !isLegacy) continue;

      const name = isSystem
        ? rel.slice(SYSTEM_TEMPLATES_PREFIX.length).replace(/\.md$/i, '')
        : rel.slice(TEMPLATES_PREFIX.length).replace(/\.md$/i, '');

      // system/ が優先: 同名の templates/ エントリはスキップ
      if (seenNames.has(name)) continue;

      const content = await readNote(config.vaultRoot, rel);
      if (content === null) continue;
      try {
        templates.push(summaryFor(rel, content));
        seenNames.add(name);
      } catch (err) {
        console.error(`[loamium] skipping broken template ${rel}:`, err);
      }
    }

    const res: TemplatesResponse = { templates };
    return c.json(res);
  });

  app.post('/api/templates/*', async (c) => {
    let name: string;
    try {
      name = nameFromInstantiatePath(c.req.path);
    } catch (err) {
      if (err instanceof VaultPathError) return errorJson(c, 400, 'invalid_path', err.message);
      throw err;
    }

    // system/templates/ → templates/ の順に探す
    const found = await resolveTemplatePath(config.vaultRoot, name);
    if (found === null) {
      return errorJson(c, 404, 'template_not_found', `template not found: ${name}`);
    }

    const { rel, content } = found;

    const body = await parseBody(c, templateInstantiateRequestSchema);
    if (!body.ok) return body.response;

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

    const cfg = parseTemplateConfig(parseNote(content).frontmatter);

    const vars: Record<string, string> = {};
    for (const def of cfg.vars) {
      vars[def.name] =
        def.default !== undefined
          ? resolveTemplate(def.default, { date: dateBase, now }).text
          : '';
    }
    for (const [k, v] of Object.entries(body.data.vars)) vars[k] = v;

    const missingRequired: string[] = [];
    for (const def of cfg.vars) {
      if (def.required && (vars[def.name] ?? '').trim() === '') missingRequired.push(def.name);
    }

    // target(保存先)を pathMode で解決
    // name の prefix を system/templates/ → templates/ から剥がして target に使う
    const nameForTarget = rel.startsWith(SYSTEM_TEMPLATES_PREFIX)
      ? rel.slice(SYSTEM_TEMPLATES_PREFIX.length).replace(/\.md$/i, '')
      : rel.slice(TEMPLATES_PREFIX.length).replace(/\.md$/i, '');

    const targetPattern = cfg.target ?? nameForTarget;
    const targetRes = resolveTemplate(targetPattern, { vars, date: dateBase, now, pathMode: true });
    const bodyTemplate = buildBodyTemplate(content);
    const bodyRes = resolveTemplate(bodyTemplate, { vars, date: dateBase, now });

    const missing: string[] = [];
    const seen = new Set<string>();
    for (const n of [...missingRequired, ...targetRes.missing, ...bodyRes.missing]) {
      if (!seen.has(n)) {
        seen.add(n);
        missing.push(n);
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
