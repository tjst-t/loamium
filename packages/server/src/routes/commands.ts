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
import {
  normalizeVaultFilePath,
  VaultPathError,
  SYSTEM_COMMANDS_DIR,
  commandRunRequestSchema,
  commandSourceWriteRequestSchema,
  type CommandRunResponse,
  type CommandSourceResponse,
  type CommandSourceWriteResponse,
  type CommandSummary,
  type CommandsResponse,
} from '@loamium/shared';
import type { ServerConfig } from '../config.js';
import type { VaultIndex } from '../noteIndex.js';
import { readNote, writeNote, noteMtime } from '../vault.js';
import { errorJson, parseBody, setAudit, type AppEnv } from '../http.js';
import { writeAuditEntry } from '../audit.js';
import {
  listAllCommandFiles,
  runCommand,
  stemFrom,
  summaryFor,
} from '../commands-service.js';

/** 旧パス (後方互換フォールバック) */
const LEGACY_COMMANDS_DIR = 'commands';


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

    // リクエストボディ検証 (params)。route 側で行い、runCommand には解決済み params を渡す。
    const body = await parseBody(c, commandRunRequestSchema);
    if (!body.ok) return body.response;

    // ステップ実行エンジンは commands-service.runCommand に集約 (ADR-0016 / ADR-0021)。
    // agent ツールと REST が同一エンジンを共有する。各バリアントを従来と同一の
    // HTTP レスポンスへマップし、挙動 (ステータス・監査・fail-stop) を不変に保つ。
    const outcome = await runCommand(config, index, name, body.data.params);

    switch (outcome.status) {
      case 'invalid_name':
        return errorJson(c, 400, 'invalid_path', outcome.message);
      case 'not_found':
        return errorJson(c, 404, 'not_found', outcome.message);
      case 'invalid_command':
        return errorJson(c, 400, 'invalid_command', outcome.message);
      case 'missing_params':
        return c.json(
          {
            error: 'missing_params',
            message: `missing required params: ${outcome.missing.join(', ')}`,
            missing: outcome.missing,
          },
          400,
        );
      case 'forbidden':
        return errorJson(c, 403, 'forbidden', outcome.message);
      case 'invalid_target_path':
        return errorJson(c, 400, 'invalid_target_path', outcome.message);
      case 'ok': {
        // 監査ログ: command.run [AC-Sd22b1f-2-3]。書き込みステップ監査は runCommand が直接記録する。
        setAudit(c, 'command.run', outcome.commandPath);
        const res: CommandRunResponse = { results: outcome.results };
        if (outcome.openPath !== undefined) res.openPath = outcome.openPath;
        return c.json(res);
      }
    }
  });

  return app;
}
