/**
 * Loamium エージェント用スマートコマンド操作ツール群 (Sc4b9d1-2 / ADR-0016)。
 *
 * ADR-0016 契約: コマンドの一覧化・ステップ実行は **REST と同一のサービス層**
 * (commands-service.ts) を経由する。エージェント専用の独自実行ロジックは新設しない。
 *
 * ツール分類とケーパビリティ (ADR-0015):
 *   - commands_list  : 読み取り系 → read ケーパビリティ。
 *   - command_run    : ステップ実行 (書き込みを伴う) → 独立ケーパビリティ command_run
 *                      (clampByMode で full のみ許可)。コマンド内ステップの実効可否は
 *                      サーバー mode 側の最終ガード (runCommand の append-only 拒否など) に従う。
 *   - command_write  : コマンド定義 (YAML) の作成・更新 → 独立ケーパビリティ command_write
 *                      (clampByMode で full のみ許可)。writeSystemCommand 経由で
 *                      system/commands/<name>.yaml へ保存する。保存前に parseLoamiumCommandFile
 *                      で YAML を検証し、不正なら書き込まない (壊れた定義を書かせない)。
 *   - command_delete : コマンド定義の削除 → command_write ケーパビリティ。
 *                      deleteSystemCommand 経由。存在しない name はエラーにしない。
 *
 * 書き込み系 (command_write / command_delete) の制約:
 *   - id (name) のパス検証は system-store の normalizeSystemPath (writeSystemCommand /
 *     deleteSystemCommand 内) が担う (`..` / 隠しセグメント脱出を拒否 → VaultPathError)。
 *   - ADR-0018: 保存/削除先 (system/commands/<name>.yaml) が deny なら書き込まない (isDenied)。
 *   - 成功時に writeAuditEntry を直接呼ぶ (Hono middleware を通らないため /
 *     op: agent.command_write | agent.command_delete)。独自ファイル操作・独自フォーマットは
 *     持たず、必ず system-store 経由で純 YAML を書く (ピュア Markdown/YAML 絶対)。
 *
 * 共通制約 (他ツールと同じ規約):
 *   - execute() は throw せず、エラー時は content テキストで返す。
 *   - 書き込みステップ + agent-run の監査は runCommand が REST と同一に直接記録する
 *     (journal-append.write / note-create.write / … / agent-run.step)。ここでは加えて
 *     command.run を 1 エントリ記録し、REST の setAudit('command.run', ...) と対応させる。
 *   - target パス検証・必須 param 不足・append-only 拒否・fail-stop はすべて runCommand が
 *     REST と同一に処理する (RunCommandResult をテキストへマップするだけ)。
 *
 * caps に含まれるツールだけを生成して返す (無効なら広告されない)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  parseLoamiumCommandFileWithError,
  normalizeSystemPath,
  SYSTEM_COMMANDS_DIR,
  VaultPathError,
  type Capability,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { writeAuditEntry } from './audit.js';
import { listAllCommandFiles, runCommand, summaryFor } from './commands-service.js';
import { writeSystemCommand, deleteSystemCommand } from './system-store.js';
import { readNote } from './vault.js';

// ---- 型エイリアス --------------------------------------------------------------

type ToolDetails = { error?: boolean; count?: number; id?: string; ran?: number; created?: boolean };

type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * スマートコマンド操作ツールを生成する (ADR-0016)。caps に含まれるケーパビリティに
 * 対応するツールだけを配列へ入れて返す (無効なら広告されない)。
 *
 * @param config   ServerConfig (vaultRoot / mode)。サービス層・audit に渡す。
 * @param index    VaultIndex。agent-run ステップ (runAgentJob) が使う。
 * @param isDenied ADR-0018 機密領域 deny 判定。command_run の各書込ステップ (解決後の
 *                 正規化パス) を書き込み直前に判定し、deny なら fail-stop で拒否する
 *                 (agent 境界の関心事。REST は runCommand に渡さないため deny 無し)。
 * @param caps     実効ケーパビリティ (ADR-0015)。
 */
export function createCommandTools(
  config: ServerConfig,
  index: VaultIndex,
  isDenied: (relPath: string) => boolean,
  caps: readonly Capability[],
): ReturnType<typeof defineTool>[] {
  const vaultRoot = config.vaultRoot;
  const capSet = new Set<Capability>(caps);
  const tools: ReturnType<typeof defineTool>[] = [];

  // ---- commands_list (read) -------------------------------------------------

  if (capSet.has('read')) {
    tools.push(
      defineTool({
        name: 'commands_list',
        label: 'スマートコマンド一覧',
        description:
          'vault に定義されたスマートコマンド (system/commands/*.yaml 優先, fallback: commands/*.yaml) の' +
          '一覧を返す。各項目の id (run に使う識別子)・表示名・説明・必須 param を表示する。' +
          '壊れた定義も valid:false として一覧に含める。入力なし。',
        parameters: Type.Object({}),
        async execute(): Promise<ToolResult> {
          // GET /api/commands と同一経路: listAllCommandFiles + summaryFor。
          const all = await listAllCommandFiles(vaultRoot);
          const summaries = [];
          for (const rel of all) {
            const content = await readNote(vaultRoot, rel);
            if (content === null) continue; // 走査後に消えたファイル
            summaries.push(summaryFor(rel, content));
          }
          if (summaries.length === 0) {
            return textResult('スマートコマンドは定義されていません。', { count: 0 });
          }
          const lines = summaries.map((s) => {
            if (!s.valid) {
              return `- ${s.id} — (無効: ${s.error})`;
            }
            const desc = s.description !== undefined && s.description !== '' ? ` — ${s.description}` : '';
            const required = s.params.filter((p) => p.required === true).map((p) => p.name);
            const req = required.length > 0 ? ` [必須 param: ${required.join(', ')}]` : '';
            return `- ${s.id} (${s.name})${desc}${req}`;
          });
          return textResult(
            `スマートコマンド (${String(summaries.length)} 件):\n${lines.join('\n')}`,
            { count: summaries.length },
          );
        },
      }),
    );
  }

  // ---- command_run (command_run) --------------------------------------------

  if (capSet.has('command_run')) {
    tools.push(
      defineTool({
        name: 'command_run',
        label: 'スマートコマンド実行',
        description:
          '指定 id のスマートコマンドをステップ順に同期実行する (POST /api/commands/{id}/run と同一エンジン)。' +
          'params はコマンド定義のパラメータ名→値マップ。必須 param 不足・最初の失敗ステップで停止 (ロールバックなし)。' +
          'append-only モードでは prop-set/note-patch/agent-run を含むコマンドは拒否される。',
        parameters: Type.Object({
          id: Type.String({ description: 'スマートコマンド id (commands_list で確認)' }),
          params: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: 'パラメータ名→値マップ (省略可)',
            }),
          ),
        }),
        async execute(_id, params): Promise<ToolResult> {
          const runParams: Record<string, string> = params.params ?? {};
          // REST と同一のステップ実行エンジンへ委譲する (commands-service.runCommand)。
          // ADR-0018: agent 経路なので isDenied を渡し、各書込ステップの deny を強制する。
          const outcome = await runCommand(config, index, params.id, runParams, isDenied);

          switch (outcome.status) {
            case 'invalid_name':
              return textResult(`コマンド名が不正です: ${outcome.message}`, {
                error: true,
                id: params.id,
              });
            case 'not_found':
              return textResult(`コマンドが見つかりません: ${params.id}`, {
                error: true,
                id: params.id,
              });
            case 'invalid_command':
              return textResult(`コマンド定義が不正です: ${outcome.message}`, {
                error: true,
                id: params.id,
              });
            case 'missing_params':
              return textResult(
                `必須パラメータが不足しています: ${outcome.missing.join(', ')}`,
                { error: true, id: params.id },
              );
            case 'forbidden':
              return textResult(`このモードでは実行できません: ${outcome.message}`, {
                error: true,
                id: params.id,
              });
            case 'invalid_target_path':
              return textResult(`ステップの保存先パスが不正です: ${outcome.message}`, {
                error: true,
                id: params.id,
              });
            case 'invalid_select_value':
              return textResult(
                `パラメータ '${outcome.paramName}' の値が候補外です: ${outcome.message}`,
                { error: true, id: params.id },
              );
            case 'ok': {
              // REST の setAudit('command.run', ...) に対応する監査を直接記録する
              // (書き込みステップ・agent-run.step は runCommand が既に記録済み)。
              await writeAuditEntry(config, {
                ts: new Date().toISOString(),
                op: 'command.run',
                path: outcome.commandPath,
                mode: config.mode,
                result: 'ok',
                status: 200,
              });
              const lines = outcome.results.map((r, i) => {
                const n = i + 1;
                if (r.skipped === true) return `${String(n)}. ${r.kind}: スキップ`;
                if (r.ok) return `${String(n)}. ${r.kind}: OK${r.path !== undefined ? ` (${r.path})` : ''}`;
                return `${String(n)}. ${r.kind}: 失敗 — ${r.error ?? '不明なエラー'}`;
              });
              const failed = outcome.results.some((r) => !r.ok);
              const header = failed
                ? `コマンド "${params.id}" は途中で失敗しました (fail-stop):`
                : `コマンド "${params.id}" を実行しました (${String(outcome.results.length)} ステップ):`;
              const open =
                outcome.openPath !== undefined ? `\n開くパス: ${outcome.openPath}` : '';
              return textResult(
                `${header}\n${lines.join('\n')}${open}`,
                { id: params.id, ran: outcome.results.length, ...(failed ? { error: true } : {}) },
              );
            }
          }
        },
      }),
    );
  }

  // ---- command_write / command_delete (command_write) -----------------------

  if (capSet.has('command_write')) {
    tools.push(
      defineTool({
        name: 'command_write',
        label: 'スマートコマンド作成/更新',
        description:
          'スマートコマンド定義 (YAML) を作成または更新する (name 既存なら上書き)。' +
          'source はコマンド YAML ファイル全体のテキスト (トップレベルに name?/description?/params[]/steps[])。' +
          'system/commands/{name}.yaml として保存する。保存前に YAML を検証し、不正なら保存せずエラーを返す。' +
          'DSL (ステップ種・params・YAML 例) は help トピック "command" を参照。',
        parameters: Type.Object({
          name: Type.String({ description: 'コマンド id (ファイル stem。例: "new-meeting")' }),
          source: Type.String({ description: 'コマンド YAML ファイル全体のテキスト' }),
        }),
        async execute(_name, params): Promise<ToolResult> {
          // 1) 保存前に YAML を検証する (壊れた定義を書かせない)。
          const parsed = parseLoamiumCommandFileWithError(params.source);
          if (!parsed.ok) {
            return textResult(`コマンド定義が不正です (保存しません): ${parsed.error}`, {
              error: true,
              id: params.name,
            });
          }

          // 2) ADR-0018: 保存先 (system/commands/<name>.yaml) が deny なら拒否する。
          //    name のパス検証も同時に行う (normalizeSystemPath が `..`/隠しセグメントを拒否)。
          let relPath: string;
          try {
            relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${params.name}.yaml`);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return textResult(`パスエラー: ${err.message}`, { error: true, id: params.name });
            }
            throw err;
          }
          if (isDenied(relPath)) {
            return textResult(`書き込みが拒否されました (機密領域): ${relPath}`, {
              error: true,
              id: params.name,
            });
          }

          // 3) system-store 経由で純 YAML を書き込む (UTF-8/LF 固定)。
          let result: { created: boolean; mtime: number };
          try {
            result = await writeSystemCommand(vaultRoot, params.name, params.source);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return textResult(`パスエラー: ${err.message}`, { error: true, id: params.name });
            }
            return textResult(`コマンドの書き込みに失敗しました: ${String(err)}`, {
              error: true,
              id: params.name,
            });
          }

          await writeAuditEntry(config, {
            ts: new Date().toISOString(),
            op: 'agent.command_write',
            path: relPath,
            mode: config.mode,
            result: 'ok',
            status: 200,
          });
          const verb = result.created ? '作成' : '更新';
          return textResult(`コマンドを${verb}しました: ${params.name}`, {
            id: params.name,
            created: result.created,
          });
        },
      }),
    );

    tools.push(
      defineTool({
        name: 'command_delete',
        label: 'スマートコマンド削除',
        description:
          '指定 name のスマートコマンド定義 (system/commands/{name}.yaml) を削除する。' +
          '存在しない name はエラーにせず「削除対象なし」を返す。',
        parameters: Type.Object({
          name: Type.String({ description: '削除するコマンド id' }),
        }),
        async execute(_name, params): Promise<ToolResult> {
          // ADR-0018: 削除先が deny なら拒否する (name のパス検証も同時に行う)。
          let relPath: string;
          try {
            relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${params.name}.yaml`);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return textResult(`パスエラー: ${err.message}`, { error: true, id: params.name });
            }
            throw err;
          }
          if (isDenied(relPath)) {
            return textResult(`削除が拒否されました (機密領域): ${relPath}`, {
              error: true,
              id: params.name,
            });
          }

          let deleted: boolean;
          try {
            deleted = await deleteSystemCommand(vaultRoot, params.name);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return textResult(`パスエラー: ${err.message}`, { error: true, id: params.name });
            }
            return textResult(`コマンドの削除に失敗しました: ${String(err)}`, {
              error: true,
              id: params.name,
            });
          }
          if (!deleted) {
            // 存在しない name はエラーにしない (削除対象なし)。監査は残さない。
            return textResult(`削除対象なし: ${params.name}`, { id: params.name });
          }
          await writeAuditEntry(config, {
            ts: new Date().toISOString(),
            op: 'agent.command_delete',
            path: relPath,
            mode: config.mode,
            result: 'ok',
            status: 200,
          });
          return textResult(`コマンドを削除しました: ${params.name}`, { id: params.name });
        },
      }),
    );
  }

  return tools;
}

/** スマートコマンドツール名の固定セット (ADR-0015 deriveToolNames と一致)。sorted。 */
export const COMMAND_TOOL_NAMES = [
  'command_delete',
  'command_run',
  'command_write',
  'commands_list',
] as const;
