/**
 * スマートコマンド定義の列挙・ステップ実行サービス層 (ADR-0016 / Sc4b9d1-2)。
 *
 * ADR-0016 契約: コマンドの一覧化・ステップ実行エンジンは Hono ハンドラに密結合させず、
 * REST (routes/commands.ts) と agent ツール (agent-command-tools.ts) の双方から呼べる
 * 純関数として置く。エージェント専用の独自実行ロジックは新設しない (二重管理の排除)。
 *
 * ここに集約する純関数:
 *   - listAllCommandFiles : GET /api/commands と同一の system/ 優先 + legacy fallback 列挙。
 *   - summaryFor          : 1 ファイル → CommandSummary (寛容: 壊れは valid:false)。
 *   - runCommand          : POST /api/commands/{name}/run と同一のステップ実行エンジン
 *                           (ADR-0021 fail-stop / 権限モード / 監査 / パス検証)。
 *                           S5a66e4 の agent-run 分岐も含めてここへ切り出す。
 *
 * runCommand は HTTP に依存しない判別可能 union (RunCommandResult) を返す。REST は
 * これを従来と同一の HTTP レスポンス (errorJson / c.json) へマップし、agent ツールは
 * テキスト結果へマップする。挙動 (ステータス・監査・fail-stop) は双方で不変。
 */
import {
  appendText,
  evaluateCondition,
  insertAtPosition,
  insertUnderHeading,
  isValidJournalDate,
  journalPath,
  normalizeVaultPath,
  normalizeVaultFilePath,
  parseLoamiumCommandFileWithError,
  parseNote,
  parseTemplateConfig,
  resolveTemplate,
  todayJournalDate,
  buildBodyTemplate,
  VaultPathError,
  SYSTEM_COMMANDS_DIR,
  SYSTEM_TEMPLATES_DIR,
  agentJobSchema,
  type AgentJob,
  type CommandStepResult,
  type CommandSummary,
} from '@loamium/shared';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { readNote, writeNote } from './vault.js';
import { writeAuditEntry } from './audit.js';
import { firstFreePath } from './vault-paths.js';
import { applyPropSet, applyNotePatch } from './routes/notes.js';
import { runAgentJob } from './agent-job-runner.js';

/** 旧パス (後方互換フォールバック) */
const LEGACY_COMMANDS_DIR = 'commands';
const LEGACY_COMMANDS_PREFIX = `${LEGACY_COMMANDS_DIR}/`;
const SYSTEM_COMMANDS_PREFIX = `${SYSTEM_COMMANDS_DIR}/`;

// ---- 列挙 / サマリ (GET /api/commands と同一経路) -------------------------------

/** vault 相対パスから stem (拡張子なし) を取り出す。system/ / legacy/ 両方に対応。 */
export function stemFrom(rel: string): string {
  let basename: string;
  if (rel.startsWith(SYSTEM_COMMANDS_PREFIX)) {
    basename = rel.slice(SYSTEM_COMMANDS_PREFIX.length);
  } else {
    basename = rel.slice(LEGACY_COMMANDS_PREFIX.length);
  }
  return basename.replace(/\.ya?ml$/i, '');
}

/**
 * vault の dirPath ディレクトリを再帰的に走査し .yaml / .yml ファイルの
 * vault 相対パス一覧を返す。
 * ドット始まりセグメントは除外する。ディレクトリが存在しない場合は空配列。
 */
async function listYamlFilesInDir(vaultRoot: string, dirPath: string): Promise<string[]> {
  const dirAbs = path.resolve(vaultRoot, dirPath);
  const out: string[] = [];
  const walk = async (dirA: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirA, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dirA, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        const rel = path
          .relative(path.resolve(vaultRoot), abs)
          .split(path.sep)
          .join('/')
          .normalize('NFC');
        out.push(rel);
      }
    }
  };
  await walk(dirAbs);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * system/commands/ を優先し、fallback: commands/ として全 YAML コマンドファイルを列挙する。
 * 同名コマンド (stem) は system/commands/ が shadowing する。
 * [AC-Sa10026-2-2]
 */
export async function listAllCommandFiles(vaultRoot: string): Promise<string[]> {
  const systemFiles = await listYamlFilesInDir(vaultRoot, SYSTEM_COMMANDS_DIR);
  const legacyFiles = await listYamlFilesInDir(vaultRoot, LEGACY_COMMANDS_DIR);

  const systemStems = new Set(systemFiles.map(stemFrom));
  const combined: string[] = [...systemFiles];

  for (const f of legacyFiles) {
    const stem = stemFrom(f);
    if (!systemStems.has(stem)) {
      combined.push(f); // system/ にない場合のみ追加
    }
  }

  combined.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return combined;
}

/** 1 ファイルの内容から CommandSummary を組み立てる (寛容: 壊れは valid:false)。 */
export function summaryFor(rel: string, content: string): CommandSummary {
  const stem = stemFrom(rel);
  const parsed = parseLoamiumCommandFileWithError(content);

  if (!parsed.ok) {
    return { id: stem, name: stem, path: rel, valid: false, error: parsed.error };
  }

  const cmd = parsed.command;
  const summary: CommandSummary = {
    id: stem,
    name: cmd.name ?? stem,
    path: rel,
    params: cmd.params,
    valid: true,
  };
  if (cmd.description !== undefined) {
    summary.description = cmd.description;
  }
  return summary;
}

// ---- runCommand (POST /api/commands/{name}/run と同一エンジン) ------------------

/**
 * runCommand の結果。HTTP に依存しない判別可能 union。
 * REST は各バリアントを従来と同一の HTTP レスポンスへ、agent ツールはテキストへマップする。
 *
 * - invalid_name       : コマンド名がパス検証で拒否 (REST: 400 invalid_path)。
 * - not_found          : コマンド未検出 (REST: 404 not_found)。
 * - invalid_command    : コマンド定義パース失敗 (REST: 400 invalid_command)。
 * - missing_params     : 必須 param 不足 (REST: 400 missing_params + missing[])。
 * - forbidden          : append-only で MUTATE ステップ含む (REST: 403 forbidden)。
 * - invalid_target_path: ステップ内の target パスがパス検証で拒否 (REST: 400 invalid_target_path)。
 *                        既存挙動どおりステップ実行を打ち切って即返す (results は打ち切り前のぶん)。
 * - ok                 : 実行完了 (results / openPath)。ステップ失敗は results 内 ok:false で表す。
 */
export type RunCommandResult =
  | { status: 'invalid_name'; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'invalid_command'; message: string }
  | { status: 'missing_params'; missing: string[] }
  | { status: 'forbidden'; message: string }
  | { status: 'invalid_target_path'; message: string; results: CommandStepResult[] }
  | { status: 'ok'; results: CommandStepResult[]; openPath?: string; commandPath: string };

/**
 * コマンドファイルを探して定義をパースし、ステップを順次同期実行する
 * (POST /api/commands/{name}/run と同一エンジン, ADR-0021)。
 *
 * 制約継承 (REST と不変):
 *   - system/commands/ 優先 → commands/ fallback (拡張子 .yaml → .yml)。
 *   - 必須 param 不足 → missing 一覧を返し実行しない。
 *   - append-only で prop-set / note-patch / agent-run を含むコマンドは拒否。
 *   - 最初の失敗ステップで停止 (ロールバックなし)。
 *   - target パスは resolveTemplate(pathMode) → normalizeVaultPath 検証。
 *   - 各書き込みステップ + agent-run は writeAuditEntry へ記録。
 *   - read-only 実行不可はサーバー mode の最終ガード (permissionMiddleware / clampByMode) が担う。
 *
 * ADR-0018 (agent 経路のみ): isDenied を渡すと、各書込ステップの解決・正規化後の
 * 実書込先を書き込み直前に deny 判定し、deny なら当該ステップを ok:false として
 * fail-stop する (ファイルは作らない)。REST/CLI は isDenied を渡さず従来どおり
 * deny 無し (ユーザー直接アクセスは agent の deny リストで制限しない)。
 */
export async function runCommand(
  config: ServerConfig,
  index: VaultIndex,
  name: string,
  params: Record<string, string>,
  isDenied?: (relPath: string) => boolean,
): Promise<RunCommandResult> {
  const vaultRoot = config.vaultRoot;
  // ADR-0018: agent 経路のみ (isDenied 指定時) 機密領域 deny を強制する。
  // REST/CLI はユーザー直接アクセスなので isDenied を渡さず、従来どおり deny 無し。
  // 各書込ステップの解決・正規化後の実書込先を書き込み直前に判定し、deny なら true。
  const denied = (rel: string): boolean => isDenied !== undefined && isDenied(rel);

  // 1. コマンドファイルを探す (system/commands/ 優先, fallback: commands/)。
  let systemBase: string;
  let legacyBase: string;
  try {
    systemBase = normalizeVaultFilePath(`${SYSTEM_COMMANDS_DIR}/${name}`);
    legacyBase = normalizeVaultFilePath(`${LEGACY_COMMANDS_DIR}/${name}`);
  } catch (err) {
    if (err instanceof VaultPathError) {
      return { status: 'invalid_name', message: `invalid command name: ${err.message}` };
    }
    throw err;
  }

  let foundCommandPath: string | undefined;
  let foundContent: string | undefined;
  for (const base of [systemBase, legacyBase]) {
    for (const ext of ['.yaml', '.yml']) {
      const candidate = `${base}${ext}`;
      const c2 = await readNote(vaultRoot, candidate);
      if (c2 !== null) {
        foundCommandPath = candidate;
        foundContent = c2;
        break;
      }
    }
    if (foundCommandPath !== undefined) break;
  }

  if (foundCommandPath === undefined || foundContent === undefined) {
    return { status: 'not_found', message: `command not found: ${name}` };
  }

  const commandPath = foundCommandPath;
  const content = foundContent;

  // 2. コマンド定義を厳格パース (ADR-0024: ファイル全体 YAML)。
  const parsed = parseLoamiumCommandFileWithError(content);
  if (!parsed.ok) {
    return { status: 'invalid_command', message: `command definition is invalid: ${parsed.error}` };
  }
  const cmd = parsed.command;

  // 3. 必須 param チェック [AC-Sd22b1f-2-2]。
  const missing: string[] = [];
  for (const p of cmd.params) {
    if (p.required === true) {
      const value = params[p.name];
      const effective = value !== undefined && value !== '' ? value : (p.default ?? '');
      if (effective.trim() === '') {
        missing.push(p.name);
      }
    }
  }
  if (missing.length > 0) {
    return { status: 'missing_params', missing };
  }

  // 4. 権限チェック [AC-Sd22b1f-2-3] [AC-Sf2f114-4-3] [AC-S5a66e4-3-3]。
  // read-only は呼び出し側 (permissionMiddleware / capability ゲート) が既に弾く。
  // append-only は prop-set / note-patch / agent-run を含むコマンド全体を拒否する。
  if (config.mode === 'append-only') {
    const hasMutatingStep = cmd.steps.some(
      (s) => s.kind === 'prop-set' || s.kind === 'note-patch' || s.kind === 'agent-run',
    );
    if (hasMutatingStep) {
      return {
        status: 'forbidden',
        message:
          'prop-set, note-patch and agent-run steps are not allowed in append-only mode (they modify existing content or delegate writes to the agent)',
      };
    }
  }

  // 5. resolve コンテキスト構築。
  const now = new Date();
  const resolvedParams: Record<string, string> = {};
  for (const p of cmd.params) {
    const val = params[p.name];
    if (val !== undefined && val !== '') {
      resolvedParams[p.name] = val;
    } else if (p.default !== undefined) {
      resolvedParams[p.name] = resolveTemplate(p.default, { date: now, now }).text;
    }
  }
  for (const [k, v] of Object.entries(params)) {
    if (!(k in resolvedParams)) {
      resolvedParams[k] = v;
    }
  }

  // 6. ステップを順次実行 [AC-Sd22b1f-2-1]。
  const results: CommandStepResult[] = [];
  let openPath: string | undefined;

  for (const step of cmd.steps) {
    const kind = step.kind;

    // ADR-0022: when / when-not 条件評価 [AC-Sf2f114-2-1/2]。
    try {
      const whenRaw = step.when;
      const whenNotRaw = step['when-not'];

      if (whenRaw !== undefined || whenNotRaw !== undefined) {
        let shouldRun = true;

        if (whenRaw !== undefined) {
          const resolved = resolveTemplate(whenRaw, { vars: resolvedParams, date: now, now });
          const condValue = resolved.missing.length > 0 ? '' : resolved.text;
          if (!evaluateCondition(condValue)) {
            shouldRun = false;
          }
        }

        if (shouldRun && whenNotRaw !== undefined) {
          const resolved = resolveTemplate(whenNotRaw, { vars: resolvedParams, date: now, now });
          const condValue = resolved.missing.length > 0 ? '' : resolved.text;
          if (evaluateCondition(condValue)) {
            shouldRun = false;
          }
        }

        if (!shouldRun) {
          results.push({ kind, ok: true, skipped: true });
          continue;
        }
      }
    } catch (condErr) {
      results.push({
        kind,
        ok: false,
        error: condErr instanceof Error ? condErr.message : String(condErr),
      });
      break;
    }

    try {
      if (kind === 'journal-append') {
        const contentResolved = resolveTemplate(step.content, {
          vars: resolvedParams,
          date: now,
          now,
        }).text;
        const dateStr =
          step.date !== undefined
            ? resolveTemplate(step.date, { vars: resolvedParams, date: now, now }).text
            : todayJournalDate(now);
        const sectionResolved =
          step.section !== undefined
            ? resolveTemplate(step.section, { vars: resolvedParams, date: now, now }).text
            : undefined;

        if (!isValidJournalDate(dateStr)) {
          results.push({
            kind,
            ok: false,
            error: `invalid journal date: "${dateStr}" (expected YYYY-MM-DD)`,
          });
          break;
        }

        const rel = journalPath(dateStr);
        if (denied(rel)) {
          results.push({
            kind,
            ok: false,
            error: `write denied by privacy rules (ADR-0018): ${rel}`,
          });
          break;
        }
        const existing = await readNote(vaultRoot, rel);

        let newContent: string;
        const positionRaw = step.position;
        if (positionRaw !== undefined) {
          const opts =
            sectionResolved !== undefined
              ? { position: positionRaw, section: sectionResolved }
              : { position: positionRaw };
          newContent = insertAtPosition(existing ?? '', opts, contentResolved);
        } else if (sectionResolved !== undefined && sectionResolved !== '') {
          newContent = insertUnderHeading(existing ?? '', sectionResolved, contentResolved);
        } else {
          newContent = appendText(existing ?? '', contentResolved);
        }

        await writeNote(vaultRoot, rel, newContent);
        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'journal-append.write',
          path: rel,
          mode: config.mode,
          result: 'ok',
          status: 200,
        });

        const stepResult: CommandStepResult = { kind, ok: true, path: rel };
        results.push(stepResult);
        if (step.open === true) openPath = rel;
      } else if (kind === 'note-append') {
        const targetRaw = resolveTemplate(step.target, {
          vars: resolvedParams,
          date: now,
          now,
          pathMode: true,
        }).text;
        const contentResolved = resolveTemplate(step.content, {
          vars: resolvedParams,
          date: now,
          now,
        }).text;
        const sectionResolved =
          step.section !== undefined
            ? resolveTemplate(step.section, { vars: resolvedParams, date: now, now }).text
            : undefined;

        let rel: string;
        try {
          rel = normalizeVaultPath(targetRaw);
        } catch (err) {
          if (err instanceof VaultPathError) {
            return {
              status: 'invalid_target_path',
              message: `invalid target path in step: ${err.message}`,
              results,
            };
          }
          throw err;
        }

        if (denied(rel)) {
          results.push({
            kind,
            ok: false,
            error: `write denied by privacy rules (ADR-0018): ${rel}`,
          });
          break;
        }

        let existing = await readNote(vaultRoot, rel);
        if (existing === null) {
          if (step.create === true) {
            existing = '';
          } else {
            results.push({ kind, ok: false, error: `note not found: ${rel}` });
            break;
          }
        }

        let newContent: string;
        const positionRaw = step.position;
        if (positionRaw !== undefined) {
          const opts =
            sectionResolved !== undefined
              ? { position: positionRaw, section: sectionResolved }
              : { position: positionRaw };
          newContent = insertAtPosition(existing, opts, contentResolved);
        } else if (sectionResolved !== undefined && sectionResolved !== '') {
          newContent = insertUnderHeading(existing, sectionResolved, contentResolved);
        } else {
          newContent = appendText(existing, contentResolved);
        }

        await writeNote(vaultRoot, rel, newContent);
        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'note-append.write',
          path: rel,
          mode: config.mode,
          result: 'ok',
          status: 200,
        });

        const stepResult: CommandStepResult = { kind, ok: true, path: rel };
        results.push(stepResult);
        if (step.open === true) openPath = rel;
      } else if (kind === 'note-create') {
        const targetRaw = resolveTemplate(step.target, {
          vars: resolvedParams,
          date: now,
          now,
          pathMode: true,
        }).text;
        const contentResolved = resolveTemplate(step.content, {
          vars: resolvedParams,
          date: now,
          now,
        }).text;

        let destRaw: string;
        try {
          destRaw = normalizeVaultPath(targetRaw);
        } catch (err) {
          if (err instanceof VaultPathError) {
            return {
              status: 'invalid_target_path',
              message: `invalid target path in step: ${err.message}`,
              results,
            };
          }
          throw err;
        }

        if (denied(destRaw)) {
          results.push({
            kind,
            ok: false,
            error: `write denied by privacy rules (ADR-0018): ${destRaw}`,
          });
          break;
        }

        const dest = await firstFreePath(vaultRoot, destRaw);
        await writeNote(vaultRoot, dest, contentResolved);
        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'note-create.write',
          path: dest,
          mode: config.mode,
          result: 'ok',
          status: 200,
        });

        const stepResult: CommandStepResult = { kind, ok: true, path: dest };
        results.push(stepResult);
        if (step.open === true) openPath = dest;
      } else if (kind === 'template-instantiate') {
        const templateNameRaw = resolveTemplate(step.template, {
          vars: resolvedParams,
          date: now,
          now,
          pathMode: true,
        }).text;

        const stepVars: Record<string, string> = {};
        if (step.vars !== undefined) {
          for (const [k, v] of Object.entries(step.vars)) {
            stepVars[k] = resolveTemplate(v, { vars: resolvedParams, date: now, now }).text;
          }
        }

        let templatePath: string;
        let templateContent: string | null = null;

        try {
          const systemTemplatePath = normalizeVaultPath(
            `${SYSTEM_TEMPLATES_DIR}/${templateNameRaw}`,
          );
          templateContent = await readNote(vaultRoot, systemTemplatePath);
          if (templateContent !== null) {
            templatePath = systemTemplatePath;
          } else {
            const legacyTemplatePath = normalizeVaultPath(`templates/${templateNameRaw}`);
            templateContent = await readNote(vaultRoot, legacyTemplatePath);
            templatePath = legacyTemplatePath;
          }
        } catch (err) {
          if (err instanceof VaultPathError) {
            return {
              status: 'invalid_target_path',
              message: `invalid target path in step: ${err.message}`,
              results,
            };
          }
          throw err;
        }

        if (templateContent === null) {
          results.push({ kind, ok: false, error: `template not found: ${templateNameRaw}` });
          break;
        }

        const cfg = parseTemplateConfig(parseNote(templateContent).frontmatter);

        const mergedVars: Record<string, string> = {};
        for (const def of cfg.vars) {
          mergedVars[def.name] =
            def.default !== undefined
              ? resolveTemplate(def.default, { date: now, now }).text
              : '';
        }
        for (const [k, v] of Object.entries(stepVars)) mergedVars[k] = v;

        const templateNameForTarget = templatePath.startsWith(`${SYSTEM_TEMPLATES_DIR}/`)
          ? templatePath.slice(`${SYSTEM_TEMPLATES_DIR}/`.length).replace(/\.md$/i, '')
          : templatePath.slice('templates/'.length).replace(/\.md$/i, '');
        const targetPattern = cfg.target ?? templateNameForTarget;
        const targetRes = resolveTemplate(targetPattern, {
          vars: mergedVars,
          date: now,
          now,
          pathMode: true,
        });

        let destRaw: string;
        try {
          destRaw = normalizeVaultPath(targetRes.text);
        } catch (err) {
          if (err instanceof VaultPathError) {
            return {
              status: 'invalid_target_path',
              message: `invalid target path in step: resolved template target is not a valid vault path: "${targetRes.text}" (${err instanceof Error ? err.message : String(err)})`,
              results,
            };
          }
          throw err;
        }

        if (denied(destRaw)) {
          results.push({
            kind,
            ok: false,
            error: `write denied by privacy rules (ADR-0018): ${destRaw}`,
          });
          break;
        }

        const bodyTemplate = buildBodyTemplate(templateContent);
        const bodyRes = resolveTemplate(bodyTemplate, { vars: mergedVars, date: now, now });

        const dest = await firstFreePath(vaultRoot, destRaw);
        await writeNote(vaultRoot, dest, bodyRes.text);
        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'template-instantiate.write',
          path: dest,
          mode: config.mode,
          result: 'ok',
          status: 200,
        });

        const stepResult: CommandStepResult = { kind, ok: true, path: dest };
        results.push(stepResult);
        if (step.open === true) openPath = dest;
      } else if (kind === 'prop-set') {
        const targetRaw = resolveTemplate(step.target, {
          vars: resolvedParams,
          date: now,
          now,
          pathMode: true,
        }).text;

        let rel: string;
        try {
          rel = normalizeVaultPath(targetRaw);
        } catch (err) {
          if (err instanceof VaultPathError) {
            return {
              status: 'invalid_target_path',
              message: `invalid target path in step: ${err.message}`,
              results,
            };
          }
          throw err;
        }

        if (denied(rel)) {
          results.push({
            kind,
            ok: false,
            error: `write denied by privacy rules (ADR-0018): ${rel}`,
          });
          break;
        }

        let resolvedSet: Record<string, string | number | boolean> | undefined;
        if (step.set !== undefined) {
          resolvedSet = {};
          for (const [key, value] of Object.entries(step.set)) {
            if (typeof value === 'string') {
              resolvedSet[key] = resolveTemplate(value, {
                vars: resolvedParams,
                date: now,
                now,
              }).text;
            } else {
              resolvedSet[key] = value;
            }
          }
        }

        if (resolvedSet === undefined && (step.unset === undefined || step.unset.length === 0)) {
          results.push({ kind, ok: true, path: rel });
          continue;
        }

        const propResult = await applyPropSet(config, {
          rel,
          set: resolvedSet,
          unset: step.unset,
        });

        if (!propResult.ok) {
          if ('notFound' in propResult) {
            results.push({ kind, ok: false, error: `note not found: ${rel}` });
            break;
          }
          results.push({ kind, ok: false, error: propResult.unprocessable });
          break;
        }

        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'prop-set.write',
          path: rel,
          mode: config.mode,
          result: 'ok',
          status: 200,
        });

        results.push({ kind, ok: true, path: rel });
      } else if (kind === 'note-patch') {
        const targetRaw = resolveTemplate(step.target, {
          vars: resolvedParams,
          date: now,
          now,
          pathMode: true,
        }).text;
        const oldResolved = resolveTemplate(step.old, {
          vars: resolvedParams,
          date: now,
          now,
        }).text;
        const newResolved = resolveTemplate(step.new, {
          vars: resolvedParams,
          date: now,
          now,
        }).text;

        let rel: string;
        try {
          rel = normalizeVaultPath(targetRaw);
        } catch (err) {
          if (err instanceof VaultPathError) {
            return {
              status: 'invalid_target_path',
              message: `invalid target path in step: ${err.message}`,
              results,
            };
          }
          throw err;
        }

        if (denied(rel)) {
          results.push({
            kind,
            ok: false,
            error: `write denied by privacy rules (ADR-0018): ${rel}`,
          });
          break;
        }

        const patchResult = await applyNotePatch(config, rel, oldResolved, newResolved);

        if (!patchResult.ok) {
          if ('notFound' in patchResult) {
            results.push({ kind, ok: false, error: `note not found: ${rel}` });
            break;
          }
          if ('oldNotFound' in patchResult) {
            results.push({ kind, ok: false, error: `old string not found in note: ${rel}` });
            break;
          }
          results.push({
            kind,
            ok: false,
            error: `old string matches ${patchResult.ambiguous} locations in ${rel}; provide a more specific old string`,
          });
          break;
        }

        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'note-patch.write',
          path: rel,
          mode: config.mode,
          result: 'ok',
          status: 200,
        });

        results.push({ kind, ok: true, path: rel });
      } else if (kind === 'agent-run') {
        // [AC-S5a66e4-3-1/2/4] 賢い処理を Pi エージェントへ委譲する (ADR-0028)。
        const promptResolved = resolveTemplate(step.prompt, {
          vars: resolvedParams,
          date: now,
          now,
        }).text;

        const jobInput: Record<string, unknown> = {
          name: `command-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          schedule: '0 0 1 1 *',
          prompt: promptResolved,
          enabled: true,
        };
        // agent-run は least-privilege: 既定 read-only。書き込み/web は step の
        // permissions で明示付与する (未指定で agent.json の権限を継承しない)。
        // scheduled agent-jobs (agent-scheduler / routes/agent-jobs) の継承挙動は
        // runAgentJob 側で保つ (ここでは job.permissions を必ず埋める)。
        jobInput['permissions'] = step.permissions !== undefined ? step.permissions : 'read-only';
        if (step.maxTurns !== undefined) jobInput['maxTurns'] = step.maxTurns;
        if (step.timeoutSec !== undefined) jobInput['timeoutSec'] = step.timeoutSec;

        const jobParsed = agentJobSchema.safeParse(jobInput);
        if (!jobParsed.success) {
          results.push({
            kind,
            ok: false,
            error: `failed to build agent job: ${jobParsed.error.errors.map((e) => e.message).join('; ')}`,
          });
          break;
        }
        const job: AgentJob = jobParsed.data;

        const { result: jobResult, error: jobError } = await runAgentJob(config, index, job);

        await writeAuditEntry(config, {
          ts: new Date().toISOString(),
          op: 'agent-run.step',
          path: commandPath,
          mode: config.mode,
          result: jobResult === 'ok' ? 'ok' : 'error',
          status: jobResult === 'ok' ? 200 : 500,
        });

        if (jobResult === 'ok') {
          results.push({ kind, ok: true });
        } else {
          results.push({
            kind,
            ok: false,
            error: `agent job ${jobResult}: ${jobError ?? 'unknown error'}`,
          });
          break;
        }
      } else {
        const exhaustiveCheck: never = step;
        results.push({
          kind: (exhaustiveCheck as { kind: string }).kind,
          ok: false,
          error: `unknown step kind: ${(exhaustiveCheck as { kind: string }).kind}`,
        });
        break;
      }
    } catch (err) {
      results.push({
        kind,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  const result: RunCommandResult = { status: 'ok', results, commandPath };
  if (openPath !== undefined) result.openPath = openPath;
  return result;
}
