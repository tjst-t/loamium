/**
 * スマートコマンド定義一覧 + 実行エンドポイント (Sd22b1f-1/2, Sa10026-2-2)。
 *
 * POST-Sa10026-2 正本: system/commands/*.yaml (ADR-0010 amendment)
 *
 * - GET  /api/commands                  system/commands/*.yaml を優先 (fallback: commands/*.yaml)
 * - POST /api/commands/{name}/run       コマンドをステップ順に同期実行する (ADR-0021)
 *
 * 後方互換: system/commands/ に存在しないコマンドは commands/ からフォールバック読み込み。
 * 同名コマンドは system/commands/ が優先 (shadowing)。
 *
 * [AC-Sd22b1f-1-2] GET: 正常な定義は { name, path, description?, params, valid:true } で返す。
 * YAML が壊れたファイルも { name, path, valid:false, error } で一覧に含め、
 * アプリを落とさない (ADR-0024: 寛容 read、priority 2)。レスポンスは常に 200。
 *
 * [AC-Sd22b1f-2-1/2/3/4] POST run:
 * - steps を順次同期実行し、ステップ毎の {kind, ok, path?, error?} + openPath? を返す
 * - 必須 param 不足 → 400 {error:'missing_params', missing[]}
 * - 最初の失敗ステップで停止、完了済みを返す (ロールバックなし)
 * - read-only モード → 403。append-only → v1 4 種すべて許可 (prop-set/note-patch は append-only 拒否)
 * - 監査ログ: command.run + 各ステップの書き込みを記録
 */
import { Hono } from 'hono';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  commandRunRequestSchema,
  commandSourceWriteRequestSchema,
  agentJobSchema,
  type AgentJob,
  type CommandRunResponse,
  type CommandSourceResponse,
  type CommandSourceWriteResponse,
  type CommandStepResult,
  type CommandSummary,
  type CommandsResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { readNote, writeNote, noteMtime } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { writeAuditEntry } from '../audit.js';
import { firstFreePath } from '../vault-paths.js';
import { applyPropSet, applyNotePatch } from './notes.js';
import { runAgentJob } from '../agent-job-runner.js';

/** 旧パス (後方互換フォールバック) */
const LEGACY_COMMANDS_DIR = 'commands';
const LEGACY_COMMANDS_PREFIX = `${LEGACY_COMMANDS_DIR}/`;
const SYSTEM_COMMANDS_PREFIX = `${SYSTEM_COMMANDS_DIR}/`;

/** vault 相対パスから stem (拡張子なし) を取り出す。system/ / legacy/ 両方に対応。 */
function stemFrom(rel: string): string {
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
        const rel = path.relative(path.resolve(vaultRoot), abs)
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
async function listAllCommandFiles(vaultRoot: string): Promise<string[]> {
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
function summaryFor(rel: string, content: string): CommandSummary {
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


export function commandsRoutes(config: ServerConfig, index: VaultIndex): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // -----------------------------------------------------------------------
  // GET /api/commands
  // system/commands/*.yaml を優先し、fallback: commands/*.yaml を列挙して
  // 寛容 read で一覧を返す (ADR-0024, Sa10026-2-2)
  // -----------------------------------------------------------------------

  app.get('/api/commands', async (c) => {
    const all = await listAllCommandFiles(config.vaultRoot);
    const commands: CommandSummary[] = [];

    for (const rel of all) {
      const content = await readNote(config.vaultRoot, rel);
      if (content === null) continue; // 走査後に消えたファイル
      try {
        commands.push(summaryFor(rel, content));
      } catch (err) {
        // 予期せぬ例外でも一覧全体を落とさない (priority 2)
        console.error(`[loamium] unexpected error reading command ${rel}:`, err);
        const stem = stemFrom(rel);
        commands.push({
          id: stem,
          name: stem,
          path: rel,
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const res: CommandsResponse = { commands };
    return c.json(res);
  });

  // -----------------------------------------------------------------------
  // GET /api/commands/{id}/source
  // system/commands/{id}.yaml を優先し、なければ commands/{id}.yaml を試みる。
  // (Sa10026-2-2: system/ 正本、後方互換フォールバック)
  // -----------------------------------------------------------------------

  app.get('/api/commands/:id/source', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));

    let systemBase: string;
    let legacyBase: string;
    try {
      systemBase = normalizeVaultFilePath(`${SYSTEM_COMMANDS_DIR}/${id}`);
      legacyBase = normalizeVaultFilePath(`${LEGACY_COMMANDS_DIR}/${id}`);
    } catch (err) {
      if (err instanceof VaultPathError) {
        return errorJson(c, 400, 'invalid_path', `invalid command id: ${err.message}`);
      }
      throw err;
    }

    // system/commands/ を優先、fallback: commands/
    let foundPath: string | undefined;
    let foundContent: string | undefined;
    for (const base of [systemBase, legacyBase]) {
      for (const ext of ['.yaml', '.yml']) {
        const candidate = `${base}${ext}`;
        const content = await readNote(config.vaultRoot, candidate);
        if (content !== null) {
          foundPath = candidate;
          foundContent = content;
          break;
        }
      }
      if (foundPath !== undefined) break;
    }

    if (foundPath === undefined || foundContent === undefined) {
      return errorJson(c, 404, 'not_found', `command source not found: ${id}`);
    }

    const mtime = (await noteMtime(config.vaultRoot, foundPath)) ?? Date.now();

    const res: CommandSourceResponse = {
      id,
      path: foundPath,
      content: foundContent,
      mtime,
    };
    return c.json(res);
  });

  // -----------------------------------------------------------------------
  // PUT /api/commands/{id}/source
  // system/commands/{id}.yaml に書き込む (Sa10026-2-2: system/ が正本)。
  // 既存ファイルが commands/ にある場合は commands/ も確認して楽観的競合検出。
  // - read-only → permissionMiddleware が 403 を返すためここには到達しない。
  // - append-only → コマンド定義の変更は MUTATE 操作のため 403 (note write と同じ扱い)。
  // - mtime 指定時: 現 mtime と不一致なら 409 conflict (楽観的競合検出)。
  // -----------------------------------------------------------------------

  app.put('/api/commands/:id/source', async (c) => {
    // append-only モードでは定義の書き換えは拒否する (note PUT と同じポリシー)
    if (config.mode === 'append-only') {
      return errorJson(c, 403, 'forbidden', 'command source write is not allowed in append-only mode');
    }

    const id = decodeURIComponent(c.req.param('id'));

    let systemBase: string;
    let legacyBase: string;
    try {
      systemBase = normalizeVaultFilePath(`${SYSTEM_COMMANDS_DIR}/${id}`);
      legacyBase = normalizeVaultFilePath(`${LEGACY_COMMANDS_DIR}/${id}`);
    } catch (err) {
      if (err instanceof VaultPathError) {
        return errorJson(c, 400, 'invalid_path', `invalid command id: ${err.message}`);
      }
      throw err;
    }

    const body = await parseBody(c, commandSourceWriteRequestSchema);
    if (!body.ok) return body.response;
    const { content, mtime: baseMtime } = body.data;

    // 既存ファイルを探す: system/commands/ → commands/ の順
    // 既存ファイルがあればその mtime で楽観的競合検出し、書き込み先は system/commands/ に統一する
    let targetPath: string | undefined;
    let isNew = false;

    for (const base of [systemBase, legacyBase]) {
      for (const ext of ['.yaml', '.yml']) {
        const candidate = `${base}${ext}`;
        const existingMtime = await noteMtime(config.vaultRoot, candidate);
        if (existingMtime !== null) {
          if (baseMtime !== undefined && existingMtime !== baseMtime) {
            return errorJson(c, 409, 'conflict', `command source has been modified since mtime=${String(baseMtime)}`);
          }
          // 書き込み先は常に system/commands/{id}.yaml (正本へ昇格)
          targetPath = `${systemBase}.yaml`;
          break;
        }
      }
      if (targetPath !== undefined) break;
    }

    if (targetPath === undefined) {
      // 新規作成: system/commands/{id}.yaml
      targetPath = `${systemBase}.yaml`;
      isNew = true;
    }

    await writeNote(config.vaultRoot, targetPath, content);
    const finalMtime = (await noteMtime(config.vaultRoot, targetPath)) ?? Date.now();
    setAudit(c, 'command.source.write', targetPath);
    await writeAuditEntry(config, {
      ts: new Date().toISOString(),
      op: 'command.source.write',
      path: targetPath,
      mode: config.mode,
      result: 'ok',
      status: 200,
    });

    const res: CommandSourceWriteResponse = {
      id,
      path: targetPath,
      // isNew: コマンドがどこにも存在しなかった場合のみ true
      // legacy path からの昇格は updated 扱い (既存コマンドの移行)
      created: isNew,
      mtime: finalMtime,
    };
    return c.json(res);
  });

  // -----------------------------------------------------------------------
  // POST /api/commands/{name}/run
  // [AC-Sd22b1f-2-1/2/3/4]
  // -----------------------------------------------------------------------

  app.post('/api/commands/:name/run', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));

    // 1. コマンドファイルを探す (Sa10026-2-2: system/commands/ 優先, fallback: commands/)
    // name はファイル名 (拡張子なし)。normalizeVaultFilePath で traversal を防ぐ。
    let systemBase: string;
    let legacyBase: string;
    try {
      systemBase = normalizeVaultFilePath(`${SYSTEM_COMMANDS_DIR}/${name}`);
      legacyBase = normalizeVaultFilePath(`${LEGACY_COMMANDS_DIR}/${name}`);
    } catch (err) {
      if (err instanceof VaultPathError) {
        return errorJson(c, 400, 'invalid_path', `invalid command name: ${err.message}`);
      }
      throw err;
    }

    // system/commands/ を優先し、なければ commands/ を試みる
    let foundCommandPath: string | undefined;
    let foundContent: string | undefined;
    for (const base of [systemBase, legacyBase]) {
      for (const ext of ['.yaml', '.yml']) {
        const candidate = `${base}${ext}`;
        const c2 = await readNote(config.vaultRoot, candidate);
        if (c2 !== null) {
          foundCommandPath = candidate;
          foundContent = c2;
          break;
        }
      }
      if (foundCommandPath !== undefined) break;
    }

    if (foundCommandPath === undefined || foundContent === undefined) {
      return errorJson(c, 404, 'not_found', `command not found: ${name}`);
    }

    const commandPath = foundCommandPath;
    const content = foundContent;

    // 2. コマンド定義を厳格パース (ADR-0024: ファイル全体 YAML)
    const parsed = parseLoamiumCommandFileWithError(content);
    if (!parsed.ok) {
      return errorJson(
        c,
        400,
        'invalid_command',
        `command definition is invalid: ${parsed.error}`,
      );
    }
    const cmd = parsed.command;

    // 3. リクエストボディ検証
    const body = await parseBody(c, commandRunRequestSchema);
    if (!body.ok) return body.response;
    const params = body.data.params;

    // 4. 必須 param チェック [AC-Sd22b1f-2-2]
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
      return c.json(
        {
          error: 'missing_params',
          message: `missing required params: ${missing.join(', ')}`,
          missing,
        },
        400,
      );
    }

    // 5. 権限チェック [AC-Sd22b1f-2-3] [AC-Sf2f114-4-3] [AC-S5a66e4-3-3]
    // read-only → permissionMiddleware が既に 403 を返すためここには到達しない。
    // append-only → v1 4 種 (journal-append / note-append / note-create / template-instantiate)
    //               は許可。prop-set / note-patch は既存コンテンツを変更する MUTATE 操作
    //               であり、純粋な追記ではないため append-only では拒否する (ADR-0021)。
    //               agent-run は Pi エージェントに任意の書き込みを委譲するため MUTATE 相当と
    //               みなし、append-only では拒否する (ADR-0028、prop-set/note-patch と同じ扱い)。
    //               これらのステップが 1 つでも含まれる場合はコマンド全体を 403 で拒否する。
    if (config.mode === 'append-only') {
      const hasMutatingStep = cmd.steps.some(
        (s) => s.kind === 'prop-set' || s.kind === 'note-patch' || s.kind === 'agent-run',
      );
      if (hasMutatingStep) {
        return errorJson(
          c,
          403,
          'forbidden',
          'prop-set, note-patch and agent-run steps are not allowed in append-only mode (they modify existing content or delegate writes to the agent)',
        );
      }
    }

    // 6. resolve コンテキスト構築
    const now = new Date();
    // params のデフォルト値を埋める
    const resolvedParams: Record<string, string> = {};
    for (const p of cmd.params) {
      const val = params[p.name];
      if (val !== undefined && val !== '') {
        resolvedParams[p.name] = val;
      } else if (p.default !== undefined) {
        // default 自体も {{date:...}} 等の展開対象 (templates と同挙動)
        resolvedParams[p.name] = resolveTemplate(p.default, { date: now, now }).text;
      }
    }
    // params で明示指定されたが定義にないキーも透過する (型的に安全)
    for (const [k, v] of Object.entries(params)) {
      if (!(k in resolvedParams)) {
        resolvedParams[k] = v;
      }
    }

    // 7. 監査ログ: command.run [AC-Sd22b1f-2-3]
    setAudit(c, 'command.run', commandPath);

    // 8. ステップを順次実行 [AC-Sd22b1f-2-1]
    const results: CommandStepResult[] = [];
    let openPath: string | undefined;

    for (const step of cmd.steps) {
      const kind = step.kind;

      // ADR-0022: when / when-not 条件評価 (resolveTemplate 展開後に truthy 判定)
      // [AC-Sf2f114-2-1/2]
      try {
        const whenRaw = step.when;
        const whenNotRaw = step['when-not'];

        if (whenRaw !== undefined || whenNotRaw !== undefined) {
          let shouldRun = true;

          if (whenRaw !== undefined) {
            const resolved = resolveTemplate(whenRaw, { vars: resolvedParams, date: now, now });
            // 未解決変数がある (missing > 0) = 参照先 param が存在しない = falsey 扱い
            const condValue = resolved.missing.length > 0 ? '' : resolved.text;
            if (!evaluateCondition(condValue)) {
              shouldRun = false;
            }
          }

          if (shouldRun && whenNotRaw !== undefined) {
            const resolved = resolveTemplate(whenNotRaw, { vars: resolvedParams, date: now, now });
            // 未解決変数がある (missing > 0) = 参照先 param が存在しない = falsey 扱い
            const condValue = resolved.missing.length > 0 ? '' : resolved.text;
            if (evaluateCondition(condValue)) {
              shouldRun = false;
            }
          }

          if (!shouldRun) {
            // スキップ: 副作用なし・失敗ではない → 次ステップ続行
            results.push({ kind, ok: true, skipped: true });
            continue;
          }
        }
      } catch (condErr) {
        // 条件展開で例外が発生した場合はステップ失敗扱いで停止
        results.push({
          kind,
          ok: false,
          error: condErr instanceof Error ? condErr.message : String(condErr),
        });
        break;
      }

      try {
        if (kind === 'journal-append') {
          // content, date?, section?, position? を展開
          const contentResolved = resolveTemplate(step.content, {
            vars: resolvedParams,
            date: now,
            now,
          }).text;
          const dateStr = step.date !== undefined
            ? resolveTemplate(step.date, { vars: resolvedParams, date: now, now }).text
            : todayJournalDate(now);
          const sectionResolved = step.section !== undefined
            ? resolveTemplate(step.section, { vars: resolvedParams, date: now, now }).text
            : undefined;

          // 日付検証
          if (!isValidJournalDate(dateStr)) {
            results.push({
              kind,
              ok: false,
              error: `invalid journal date: "${dateStr}" (expected YYYY-MM-DD)`,
            });
            break;
          }

          const rel = journalPath(dateStr);
          const existing = await readNote(config.vaultRoot, rel);

          // position: 省略時は後方互換 (section あり → 'section'、なし → 'bottom') [AC-Sf2f114-3-2]
          let newContent: string;
          const positionRaw = step.position;
          if (positionRaw !== undefined) {
            const opts = sectionResolved !== undefined
              ? { position: positionRaw, section: sectionResolved }
              : { position: positionRaw };
            newContent = insertAtPosition(existing ?? '', opts, contentResolved);
          } else if (sectionResolved !== undefined && sectionResolved !== '') {
            // section 指定: 見出し配下の末尾に挿入 [AC-Sd22b1f-2-1]
            newContent = insertUnderHeading(existing ?? '', sectionResolved, contentResolved);
          } else {
            // section なし: ファイル末尾に追記
            newContent = appendText(existing ?? '', contentResolved);
          }

          await writeNote(config.vaultRoot, rel, newContent);
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
          // target, content, section?, create?, position? を展開 [AC-Sf2f114-3-1]
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
          const sectionResolved = step.section !== undefined
            ? resolveTemplate(step.section, { vars: resolvedParams, date: now, now }).text
            : undefined;

          // target path 検証 [AC-Sd22b1f-2-2] — traversal/hidden-segment は 400 で即拒否
          let rel: string;
          try {
            rel = normalizeVaultPath(targetRaw);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return errorJson(
                c,
                400,
                'invalid_target_path',
                `invalid target path in step: ${err.message}`,
              );
            }
            throw err;
          }

          let existing = await readNote(config.vaultRoot, rel);
          if (existing === null) {
            if (step.create === true) {
              // create:true → 存在しないノートを新規作成 (空コンテンツに追記) [AC-Sf2f114-3-1]
              existing = '';
            } else {
              // create 未指定 or false → 後方互換: ok:false で fail-stop [AC-Sf2f114-3-2]
              results.push({ kind, ok: false, error: `note not found: ${rel}` });
              break;
            }
          }

          // 挿入位置の決定: position 明示 → それに従う。省略時は後方互換
          // (section あり → 'section'、なし → 'bottom') [AC-Sf2f114-3-1]
          let newContent: string;
          const positionRaw = step.position;
          if (positionRaw !== undefined) {
            const opts = sectionResolved !== undefined
              ? { position: positionRaw, section: sectionResolved }
              : { position: positionRaw };
            newContent = insertAtPosition(existing, opts, contentResolved);
          } else if (sectionResolved !== undefined && sectionResolved !== '') {
            newContent = insertUnderHeading(existing, sectionResolved, contentResolved);
          } else {
            newContent = appendText(existing, contentResolved);
          }

          await writeNote(config.vaultRoot, rel, newContent);
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
          // target, content を展開
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

          // target path 検証 [AC-Sd22b1f-2-2] — traversal/hidden-segment は 400 で即拒否
          let destRaw: string;
          try {
            destRaw = normalizeVaultPath(targetRaw);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return errorJson(
                c,
                400,
                'invalid_target_path',
                `invalid target path in step: ${err.message}`,
              );
            }
            throw err;
          }

          // 衝突時は連番サフィックス [AC-Sd22b1f-2-4]
          const dest = await firstFreePath(config.vaultRoot, destRaw);
          await writeNote(config.vaultRoot, dest, contentResolved);
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
          // template, vars を展開
          const templateNameRaw = resolveTemplate(step.template, {
            vars: resolvedParams,
            date: now,
            now,
            pathMode: true,
          }).text;

          // vars の値も展開
          const stepVars: Record<string, string> = {};
          if (step.vars !== undefined) {
            for (const [k, v] of Object.entries(step.vars)) {
              stepVars[k] = resolveTemplate(v, { vars: resolvedParams, date: now, now }).text;
            }
          }

          // テンプレートパスを正規化 — system/templates/ を優先, fallback: templates/
          // traversal/hidden-segment は 400 で即拒否
          let templatePath: string;
          let templateContent: string | null = null;

          // system/templates/{name}.md を試みる
          try {
            const systemTemplatePath = normalizeVaultPath(`${SYSTEM_TEMPLATES_DIR}/${templateNameRaw}`);
            templateContent = await readNote(config.vaultRoot, systemTemplatePath);
            if (templateContent !== null) {
              templatePath = systemTemplatePath;
            } else {
              // fallback: templates/{name}.md (後方互換)
              const legacyTemplatePath = normalizeVaultPath(`templates/${templateNameRaw}`);
              templateContent = await readNote(config.vaultRoot, legacyTemplatePath);
              templatePath = legacyTemplatePath;
            }
          } catch (err) {
            if (err instanceof VaultPathError) {
              return errorJson(
                c,
                400,
                'invalid_target_path',
                `invalid target path in step: ${err.message}`,
              );
            }
            throw err;
          }

          if (templateContent === null) {
            results.push({ kind, ok: false, error: `template not found: ${templateNameRaw}` });
            break;
          }

          const cfg = parseTemplateConfig(parseNote(templateContent).frontmatter);

          // 変数をマージ (cfg.vars のデフォルト → stepVars で上書き)
          const mergedVars: Record<string, string> = {};
          for (const def of cfg.vars) {
            mergedVars[def.name] =
              def.default !== undefined
                ? resolveTemplate(def.default, { date: now, now }).text
                : '';
          }
          for (const [k, v] of Object.entries(stepVars)) mergedVars[k] = v;

          // target 解決 (どちらのパスプレフィックスも剥がす)
          const templateNameForTarget = templatePath.startsWith(`${SYSTEM_TEMPLATES_DIR}/`)
            ? templatePath.slice(`${SYSTEM_TEMPLATES_DIR}/`.length).replace(/\.md$/i, '')
            : templatePath.slice('templates/'.length).replace(/\.md$/i, '');
          const targetPattern =
            cfg.target ?? templateNameForTarget;
          const targetRes = resolveTemplate(targetPattern, {
            vars: mergedVars,
            date: now,
            now,
            pathMode: true,
          });

          // 展開後 target path 検証 — traversal/hidden-segment は 400 で即拒否
          let destRaw: string;
          try {
            destRaw = normalizeVaultPath(targetRes.text);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return errorJson(
                c,
                400,
                'invalid_target_path',
                `invalid target path in step: resolved template target is not a valid vault path: "${targetRes.text}" (${err instanceof Error ? err.message : String(err)})`,
              );
            }
            throw err;
          }

          // 本文展開
          const bodyTemplate = buildBodyTemplate(templateContent);
          const bodyRes = resolveTemplate(bodyTemplate, { vars: mergedVars, date: now, now });

          const dest = await firstFreePath(config.vaultRoot, destRaw);
          await writeNote(config.vaultRoot, dest, bodyRes.text);
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
          // target, string values を展開 [AC-Sf2f114-4-1]
          const targetRaw = resolveTemplate(step.target, {
            vars: resolvedParams,
            date: now,
            now,
            pathMode: true,
          }).text;

          // target path 検証 — traversal/hidden-segment は 400 で即拒否
          let rel: string;
          try {
            rel = normalizeVaultPath(targetRaw);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return errorJson(
                c,
                400,
                'invalid_target_path',
                `invalid target path in step: ${err.message}`,
              );
            }
            throw err;
          }

          // set の string 値を resolveTemplate 展開する
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

          // set / unset いずれも省略 → no-op (ok:true)
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
            // unprocessable — 安全のため書かずに失敗
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
          // target, old, new を展開 [AC-Sf2f114-4-2]
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

          // target path 検証 — traversal/hidden-segment は 400 で即拒否
          let rel: string;
          try {
            rel = normalizeVaultPath(targetRaw);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return errorJson(
                c,
                400,
                'invalid_target_path',
                `invalid target path in step: ${err.message}`,
              );
            }
            throw err;
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
            // ambiguous
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
          // 新規ジョブ実行コードは書かず、S2fe109 の runAgentJob を再利用する。
          // prompt を resolveTemplate で展開し、agentJobSchema 形の一時ジョブを組み立てる。
          // 結果のファイル書き込みは agent-run 独自経路を持たず、エージェント自身が
          // ADR-0016 の監査済みツール (journal_append / note_create / note_edit) を
          // prompt 指示に従って使う (書き込み先は commands.ts では強制しない)。
          const promptResolved = resolveTemplate(step.prompt, {
            vars: resolvedParams,
            date: now,
            now,
          }).text;

          // 一時ジョブを組み立てる。maxTurns/timeoutSec 省略時は agentJobSchema の
          // 既定 (20/120) を parse で補完する。permissions は enum 制約された値のため
          // テンプレート展開せずそのまま渡す (agentJobSchema が再検証する)。
          const jobInput: Record<string, unknown> = {
            name: `command-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            // schedule は runAgentJob では未使用のダミー (スキーマ充足のため)
            schedule: '0 0 1 1 *',
            prompt: promptResolved,
            enabled: true,
          };
          if (step.permissions !== undefined) jobInput['permissions'] = step.permissions;
          if (step.maxTurns !== undefined) jobInput['maxTurns'] = step.maxTurns;
          if (step.timeoutSec !== undefined) jobInput['timeoutSec'] = step.timeoutSec;

          const jobParsed = agentJobSchema.safeParse(jobInput);
          if (!jobParsed.success) {
            // 到達しにくい (step は既に検証済み) が、握りつぶさず失敗として停止する
            results.push({
              kind,
              ok: false,
              error: `failed to build agent job: ${jobParsed.error.errors.map((e) => e.message).join('; ')}`,
            });
            break;
          }
          const job: AgentJob = jobParsed.data;

          // 既存 runAgentJob へ委譲 (agent.json 未設定なら result:'error' が返り fail-stop する)
          const { result: jobResult, error: jobError } = await runAgentJob(config, index, job);

          // command.run に加え agent 側書き込みも監査に残る (ADR-0028)。
          // ここでは agent-run ステップ自体の実行結果を監査へ記録する。
          await writeAuditEntry(config, {
            ts: new Date().toISOString(),
            op: 'agent-run.step',
            path: commandPath,
            mode: config.mode,
            result: jobResult === 'ok' ? 'ok' : 'error',
            status: jobResult === 'ok' ? 200 : 500,
          });

          if (jobResult === 'ok') {
            // 書き込み先はエージェント任せのため path は省略する [AC-S5a66e4-3-2]
            results.push({ kind, ok: true });
          } else {
            // error | timeout | aborted → ok:false で fail-stop [AC-S5a66e4-3-2]
            results.push({
              kind,
              ok: false,
              error: `agent job ${jobResult}: ${jobError ?? 'unknown error'}`,
            });
            break;
          }

        } else {
          // 未知の kind (将来の拡張など — 現在は 7 種すべてを網羅しているためここには到達しない)
          const exhaustiveCheck: never = step;
          results.push({
            kind: (exhaustiveCheck as { kind: string }).kind,
            ok: false,
            error: `unknown step kind: ${(exhaustiveCheck as { kind: string }).kind}`,
          });
          break;
        }
      } catch (err) {
        // 予期せぬ例外 → ステップ失敗扱いで停止
        results.push({
          kind,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    const res: CommandRunResponse = { results };
    if (openPath !== undefined) res.openPath = openPath;
    return c.json(res);
  });

  return app;
}
