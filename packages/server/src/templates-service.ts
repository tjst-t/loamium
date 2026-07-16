/**
 * テンプレートの列挙・解決・インスタンス化サービス層 (ADR-0016 / Sc4b9d1-3)。
 *
 * ADR-0016 契約: テンプレートの一覧化・解決エンジンは Hono ハンドラに密結合させず、
 * REST (routes/templates.ts) と agent ツール (agent-template-tools.ts) の双方から
 * 呼べる純関数として置く。エージェント専用の独自解決ロジックは新設しない。
 *
 * 正本: system/templates/*.md (ADR-0010 amendment)。fallback: templates/*.md。
 *
 * ここに集約する純関数:
 *   - listTemplates      : GET /api/templates と同一の列挙 (system/ 優先・壊れはスキップ)。
 *   - resolveTemplatePath: system/templates/{name}.md → templates/{name}.md の順に探す。
 *   - instantiateTemplate: POST /api/templates/{name}/instantiate と同一の解決エンジン
 *     (resolveTemplatePath → parseTemplateConfig → resolveTemplate → firstFreePath →
 *      writeNote)。結果ノートはピュア Markdown (loamium-template 記法が残らない)。
 *
 * instantiateTemplate は HTTP に依存しない判別可能 union を返す。REST は従来と同一の
 * HTTP レスポンスへ、agent ツールはテキストへマップする (挙動不変)。
 */
import {
  buildBodyTemplate,
  isValidJournalDate,
  normalizeVaultPath,
  parseNote,
  parseTemplateConfig,
  resolveTemplate,
  VaultPathError,
  SYSTEM_TEMPLATES_DIR,
  type TemplateSummary,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { listNoteFiles, readNote, writeNote } from './vault.js';
import { firstFreePath } from './vault-paths.js';

const TEMPLATES_DIR = 'templates';
const TEMPLATES_PREFIX = `${TEMPLATES_DIR}/`;
const SYSTEM_TEMPLATES_PREFIX = `${SYSTEM_TEMPLATES_DIR}/`;

/** 1 ファイルの内容から TemplateSummary を組み立てる (GET /api/templates と同一)。 */
export function summaryFor(rel: string, content: string): TemplateSummary {
  const cfg = parseTemplateConfig(parseNote(content).frontmatter);
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

/**
 * vault 内の可視テンプレートを列挙する (GET /api/templates と同一ロジック)。
 * system/templates/ を優先し、同名の templates/ エントリはスキップ (後方互換 shadowing)。
 * 壊れたテンプレート (summaryFor が throw) はスキップしてアプリを落とさない。
 */
export async function listTemplates(vaultRoot: string): Promise<TemplateSummary[]> {
  const all = await listNoteFiles(vaultRoot);
  const templates: TemplateSummary[] = [];
  const seenNames = new Set<string>();

  for (const rel of all) {
    const isSystem = rel.startsWith(SYSTEM_TEMPLATES_PREFIX);
    const isLegacy = rel.startsWith(TEMPLATES_PREFIX);
    if (!isSystem && !isLegacy) continue;

    const name = isSystem
      ? rel.slice(SYSTEM_TEMPLATES_PREFIX.length).replace(/\.md$/i, '')
      : rel.slice(TEMPLATES_PREFIX.length).replace(/\.md$/i, '');

    if (seenNames.has(name)) continue;

    const content = await readNote(vaultRoot, rel);
    if (content === null) continue;
    try {
      templates.push(summaryFor(rel, content));
      seenNames.add(name);
    } catch (err) {
      console.error(`[loamium] skipping broken template ${rel}:`, err);
    }
  }

  return templates;
}

/**
 * テンプレートを解決する: system/templates/{name}.md → templates/{name}.md の順に探す。
 * [AC-Sa10026-2-2]: 旧パスの寛容 read フォールバック。
 */
export async function resolveTemplatePath(
  vaultRoot: string,
  name: string,
): Promise<{ rel: string; content: string } | null> {
  const systemRel = normalizeVaultPath(`${SYSTEM_TEMPLATES_DIR}/${name}`);
  const systemContent = await readNote(vaultRoot, systemRel);
  if (systemContent !== null) {
    return { rel: systemRel, content: systemContent };
  }

  const legacyRel = normalizeVaultPath(`${TEMPLATES_DIR}/${name}`);
  const legacyContent = await readNote(vaultRoot, legacyRel);
  if (legacyContent !== null) {
    return { rel: legacyRel, content: legacyContent };
  }

  return null;
}

/**
 * instantiateTemplate の結果。HTTP に依存しない判別可能 union。
 *
 * - invalid_date   : date が YYYY-MM-DD でない (REST: 400 invalid_date)。
 * - not_found      : テンプレート未検出 (REST: 404 template_not_found)。
 * - missing_vars   : 必須変数 / target・本文の未解決変数あり (REST: 400 missing_vars + missing[])。
 * - invalid_target : 解決後 target が vault パスとして不正 (REST: 400 invalid_target)。
 * - denied         : ADR-0018 機密領域 deny により保存先が拒否 (agent 経路のみ発生。
 *                    REST は isDenied を渡さないため到達不能)。
 * - ok             : ノート生成成功 (path = firstFreePath 後の保存先)。
 */
export type InstantiateTemplateResult =
  | { status: 'invalid_date'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'missing_vars'; missing: string[] }
  | { status: 'invalid_target'; message: string }
  | { status: 'denied'; message: string }
  | { status: 'ok'; path: string };

/**
 * テンプレート {name} を解決し変数を埋めて新規ノートを生成する
 * (POST /api/templates/{name}/instantiate と同一解決エンジン)。
 *
 * 制約継承 (REST と不変):
 *   - resolveTemplatePath → parseTemplateConfig → resolveTemplate → firstFreePath → writeNote。
 *   - 必須変数 (required) と target / 本文の未解決変数を集約し、あれば missing_vars で返す。
 *   - target は cfg.target ?? name を pathMode 解決後 normalizeVaultPath で検証。
 *   - 衝突は firstFreePath で連番回避。
 *   - 結果ノートはピュア Markdown (buildBodyTemplate が loamium-template 記法を除去)。
 *
 * 監査 (op: template.instantiate / agent.template_instantiate) は呼び出し側が記録する。
 *
 * ADR-0018 (agent 経路のみ): isDenied を渡すと、pathMode 解決 + normalizeVaultPath 後の
 * 実保存先を書き込み直前に deny 判定し、deny なら status:'denied' を返してノートを作らない。
 * REST/CLI は isDenied を渡さず従来どおり deny 無し (ユーザー直接アクセス)。
 */
export async function instantiateTemplate(
  config: ServerConfig,
  name: string,
  varsInput: Record<string, string>,
  date?: string,
  isDenied?: (relPath: string) => boolean,
): Promise<InstantiateTemplateResult> {
  const vaultRoot = config.vaultRoot;

  const found = await resolveTemplatePath(vaultRoot, name);
  if (found === null) {
    return { status: 'not_found', message: `template not found: ${name}` };
  }
  const { rel, content } = found;

  const now = new Date();
  let dateBase = now;
  if (date !== undefined) {
    if (!isValidJournalDate(date)) {
      return { status: 'invalid_date', message: `invalid date: "${date}" (expected YYYY-MM-DD)` };
    }
    const [y, m, d] = date.split('-').map(Number);
    dateBase = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  }

  const cfg = parseTemplateConfig(parseNote(content).frontmatter);

  const vars: Record<string, string> = {};
  for (const def of cfg.vars) {
    vars[def.name] =
      def.default !== undefined ? resolveTemplate(def.default, { date: dateBase, now }).text : '';
  }
  for (const [k, v] of Object.entries(varsInput)) vars[k] = v;

  const missingRequired: string[] = [];
  for (const def of cfg.vars) {
    if (def.required && (vars[def.name] ?? '').trim() === '') missingRequired.push(def.name);
  }

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
    return { status: 'missing_vars', missing };
  }

  let destRaw: string;
  try {
    destRaw = normalizeVaultPath(targetRes.text);
  } catch (err) {
    if (err instanceof VaultPathError) {
      return {
        status: 'invalid_target',
        message: `resolved target is not a valid vault path: "${targetRes.text}" (${err.message})`,
      };
    }
    throw err;
  }

  // ADR-0018: agent 経路のみ、正規化後の実保存先を書き込み直前に deny 判定する。
  if (isDenied !== undefined && isDenied(destRaw)) {
    return {
      status: 'denied',
      message: `save target is denied by privacy rules (ADR-0018): ${destRaw}`,
    };
  }

  const dest = await firstFreePath(vaultRoot, destRaw);
  await writeNote(vaultRoot, dest, bodyRes.text);
  return { status: 'ok', path: dest };
}
