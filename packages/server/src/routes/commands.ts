/**
 * スマートコマンド定義一覧 + 実行エンドポイント (Sd22b1f-1/2)。
 *
 * - GET  /api/commands                  vault 内 commands/*.md を寛容 read で列挙する
 * - POST /api/commands/{name}/run       コマンドをステップ順に同期実行する (ADR-0009)
 *
 * [AC-Sd22b1f-1-2] GET: 正常な定義は { name, path, description?, params, valid:true } で返す。
 * frontmatter が壊れたファイルも { name, path, valid:false, error } で一覧に含め、
 * アプリを落とさない (ADR-0008: 寛容 read、priority 2)。レスポンスは常に 200。
 *
 * [AC-Sd22b1f-2-1/2/3/4] POST run:
 * - steps を順次同期実行し、ステップ毎の {kind, ok, path?, error?} + openPath? を返す
 * - 必須 param 不足 → 400 {error:'missing_params', missing[]}
 * - 最初の失敗ステップで停止、完了済みを返す (ロールバックなし)
 * - read-only モード → 403。append-only → v1 4 種すべて許可
 * - 監査ログ: command.run + 各ステップの書き込みを記録
 */
import { Hono } from 'hono';
import {
  appendText,
  evaluateCondition,
  insertAtPosition,
  insertUnderHeading,
  isValidJournalDate,
  journalPath,
  normalizeVaultPath,
  parseLoamiumCommandWithError,
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
import { listNoteFiles, readNote, writeNote } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { writeAuditEntry } from '../audit.js';
import { firstFreePath } from '../vault-paths.js';

const COMMANDS_DIR = 'commands';
const COMMANDS_PREFIX = `${COMMANDS_DIR}/`;

/** vault 相対パスからファイル名 (拡張子なし) を取り出す。 */
function stemFrom(rel: string): string {
  const basename = rel.slice(COMMANDS_PREFIX.length);
  return basename.replace(/\.md$/i, '');
}

/** 1 ファイルの内容から CommandSummary を組み立てる (寛容: 壊れは valid:false)。 */
function summaryFor(rel: string, content: string): CommandSummary {
  const stem = stemFrom(rel);
  const { frontmatter } = parseNote(content);
  const parsed = parseLoamiumCommandWithError(frontmatter);

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
  // -----------------------------------------------------------------------

  app.get('/api/commands', async (c) => {
    const all = await listNoteFiles(config.vaultRoot);
    const commands: CommandSummary[] = [];

    for (const rel of all) {
      if (!rel.startsWith(COMMANDS_PREFIX)) continue;
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

    // 1. コマンドファイルを探す
    // name はファイル名 (拡張子なし)。commands/{name}.md が対象。
    // name にスラッシュを含む場合はサブディレクトリを許容するが、
    // normalizeVaultPath で traversal を防ぐ。
    let commandPath: string;
    try {
      commandPath = normalizeVaultPath(`${COMMANDS_DIR}/${name}`);
    } catch (err) {
      if (err instanceof VaultPathError) {
        return errorJson(c, 400, 'invalid_path', `invalid command name: ${err.message}`);
      }
      throw err;
    }

    const content = await readNote(config.vaultRoot, commandPath);
    if (content === null) {
      return errorJson(c, 404, 'not_found', `command not found: ${name}`);
    }

    // 2. コマンド定義を厳格パース (実行時は strict — ADR-0008)
    const { frontmatter } = parseNote(content);
    const parsed = parseLoamiumCommandWithError(frontmatter);
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

    // 5. 権限チェック [AC-Sd22b1f-2-3]
    // read-only → permissionMiddleware が既に 403 を返すためここには到達しない。
    // append-only → v1 4 種のみで構成されたコマンドを許可
    // (ADR-0009: append-only では append 系 = v1 の 4 種すべてが許可される)
    // append-only では v1 4 種のみ許可。v1 以外の kind は検証エラーになるため
    // ここに到達した時点では 4 種のいずれかのみ — 追加チェック不要。
    // (ADR-0009: "append-only では append 系ステップ(journal-append / note-append /
    //  note-create / template-instantiate = 新規作成)のみで構成されたコマンドを許可")

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

        } else {
          // 未知の kind (将来の拡張など — v1 では到達しないはず)
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
