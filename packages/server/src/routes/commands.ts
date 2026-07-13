/**
 * スマートコマンド定義一覧 + 実行エンドポイント (Sd22b1f-1/2)。
 *
 * - GET  /api/commands                  vault 内 commands/*.yaml(/.yml) を寛容 read で列挙する (ADR-0012)
 * - POST /api/commands/{name}/run       コマンドをステップ順に同期実行する (ADR-0009)
 *
 * [AC-Sd22b1f-1-2] GET: 正常な定義は { name, path, description?, params, valid:true } で返す。
 * YAML が壊れたファイルも { name, path, valid:false, error } で一覧に含め、
 * アプリを落とさない (ADR-0012: 寛容 read、priority 2)。レスポンスは常に 200。
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
  commandRunRequestSchema,
  type CommandRunResponse,
  type CommandStepResult,
  type CommandSummary,
  type CommandsResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import { readNote, writeNote } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { writeAuditEntry } from '../audit.js';
import { firstFreePath } from '../vault-paths.js';
import { applyPropSet, applyNotePatch } from './notes.js';

const COMMANDS_DIR = 'commands';
const COMMANDS_PREFIX = `${COMMANDS_DIR}/`;

/** vault 相対パスからファイル名 (拡張子なし) を取り出す (.yaml / .yml を除去)。 */
function stemFrom(rel: string): string {
  const basename = rel.slice(COMMANDS_PREFIX.length);
  return basename.replace(/\.ya?ml$/i, '');
}

/**
 * vault の commands/ ディレクトリを再帰的に走査し .yaml / .yml ファイルの
 * vault 相対パス一覧を返す (ADR-0012)。
 * listNoteFiles は .md のみ返すため、commands/ は独自に列挙する。
 * ドット始まりセグメント (.loamium / .git 等) は除外する。
 */
async function listYamlCommandFiles(vaultRoot: string): Promise<string[]> {
  const commandsAbs = path.resolve(vaultRoot, COMMANDS_DIR);
  const out: string[] = [];
  const walk = async (dirAbs: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // commands/ が存在しない場合など
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, entry.name);
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
  await walk(commandsAbs);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
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


export function commandsRoutes(config: ServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // -----------------------------------------------------------------------
  // GET /api/commands
  // commands/*.yaml (および .yml) を列挙して寛容 read で一覧を返す (ADR-0012)
  // -----------------------------------------------------------------------

  app.get('/api/commands', async (c) => {
    const all = await listYamlCommandFiles(config.vaultRoot);
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
  // POST /api/commands/{name}/run
  // [AC-Sd22b1f-2-1/2/3/4]
  // -----------------------------------------------------------------------

  app.post('/api/commands/:name/run', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));

    // 1. コマンドファイルを探す (ADR-0012: .yaml → .yml の順に試行)
    // name はファイル名 (拡張子なし)。commands/{name}.yaml が対象。
    // name にスラッシュを含む場合はサブディレクトリを許容するが、
    // normalizeVaultFilePath で traversal を防ぐ (.md を補完しない)。
    let commandPathBase: string;
    try {
      commandPathBase = normalizeVaultFilePath(`${COMMANDS_DIR}/${name}`);
    } catch (err) {
      if (err instanceof VaultPathError) {
        return errorJson(c, 400, 'invalid_path', `invalid command name: ${err.message}`);
      }
      throw err;
    }

    // .yaml を優先し、なければ .yml を試みる
    let foundCommandPath: string | undefined;
    let foundContent: string | undefined;
    for (const ext of ['.yaml', '.yml']) {
      const candidate = `${commandPathBase}${ext}`;
      const c2 = await readNote(config.vaultRoot, candidate);
      if (c2 !== null) {
        foundCommandPath = candidate;
        foundContent = c2;
        break;
      }
    }

    if (foundCommandPath === undefined || foundContent === undefined) {
      return errorJson(c, 404, 'not_found', `command not found: ${name}`);
    }

    const commandPath = foundCommandPath;
    const content = foundContent;

    // 2. コマンド定義を厳格パース (ADR-0012: ファイル全体 YAML)
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

    // 5. 権限チェック [AC-Sd22b1f-2-3] [AC-Sf2f114-4-3]
    // read-only → permissionMiddleware が既に 403 を返すためここには到達しない。
    // append-only → v1 4 種 (journal-append / note-append / note-create / template-instantiate)
    //               は許可。prop-set / note-patch は既存コンテンツを変更する MUTATE 操作
    //               であり、純粋な追記ではないため append-only では拒否する (ADR-0009)。
    //               コマンドに prop-set / note-patch ステップが 1 つでも含まれる場合は
    //               コマンド全体を 403 で拒否する (安全側の選択)。
    if (config.mode === 'append-only') {
      const hasMutatingStep = cmd.steps.some(
        (s) => s.kind === 'prop-set' || s.kind === 'note-patch',
      );
      if (hasMutatingStep) {
        return errorJson(
          c,
          403,
          'forbidden',
          'prop-set and note-patch steps are not allowed in append-only mode (they modify existing content)',
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

      // ADR-0010: when / when-not 条件評価 (resolveTemplate 展開後に truthy 判定)
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

          // テンプレートパスを正規化 — traversal/hidden-segment は 400 で即拒否
          let templatePath: string;
          try {
            templatePath = normalizeVaultPath(`templates/${templateNameRaw}`);
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

          const templateContent = await readNote(config.vaultRoot, templatePath);
          if (templateContent === null) {
            results.push({ kind, ok: false, error: `template not found: ${templatePath}` });
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

          // target 解決
          const targetPattern =
            cfg.target ?? templatePath.slice('templates/'.length).replace(/\.md$/i, '');
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

        } else {
          // 未知の kind (将来の拡張など — 現在は 6 種すべてを網羅しているためここには到達しない)
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
