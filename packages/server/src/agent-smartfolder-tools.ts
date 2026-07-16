/**
 * Loamium エージェント用スマートフォルダ操作ツール群 (Sc4b9d1-1 / ADR-0016)。
 *
 * ADR-0016 契約: スマートフォルダの list/notes/write/delete は **REST と同一のサービス層**
 * (smart-folders-service.ts + system-store.ts) を経由する。エージェント専用の直接ファイル
 * 走査・独自 YAML 直列化・独自 notes 解決は新設しない (二重管理の排除)。
 *
 * ツール分類とケーパビリティ (ADR-0015):
 *   - smartfolders_list / smartfolder_notes : 読み取り系 → read ケーパビリティ
 *   - smartfolder_write / smartfolder_delete: 書き込み系 → smartfolder_write ケーパビリティ
 *     (clampByMode で full のみ許可)
 *
 * 共通制約 (read/write ツールと同じ規約):
 *   - execute() は throw せず、エラー時は content テキストで返す (id 不明は not-found テキスト)。
 *   - 書き込み成功時に writeAuditEntry(config, ...) を **直接** 呼ぶ
 *     (Hono middleware を通らないため / op: agent.smartfolder_write | agent.smartfolder_delete)。
 *   - id のパス検証は system-store の normalizeSystemPath (writeSystemSmartFolder 内) が担う。
 *   - ADR-0018: notes 解決は deny 除外済みビュー経由で、機密ノートを一覧に出さない。
 *
 * caps (有効ケーパビリティ) に含まれるツールだけを生成して返す
 * (無効なら配列に入れない = LLM に広告されない)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  parseQuery,
  DqlParseError,
  VaultPathError,
  type Capability,
  type NoteMeta,
  type SmartViewQueryItem,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { writeAuditEntry } from './audit.js';
import {
  readSmartFoldersConfig,
  resolveSmartFolderNotes,
  serializeSmartFolderYaml,
} from './smart-folders-service.js';
import { writeSystemSmartFolder, deleteSystemSmartFolder } from './system-store.js';

// ---- 型エイリアス --------------------------------------------------------------

/** 全ツールの details 型 (read/write ツールと同一の汎用形状)。 */
type ToolDetails = { error?: boolean; count?: number; id?: string; created?: boolean };

type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

/** ツール結果を組み立てる共通ヘルパー (read/write ツールと同一)。 */
function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

/** 書き込み成功時に監査ログへ 1 エントリ直接記録する (op: agent.<tool>)。 */
async function audit(config: ServerConfig, op: string, id: string): Promise<void> {
  await writeAuditEntry(config, {
    ts: new Date().toISOString(),
    op,
    path: `system/smart-folders/${id}.yaml`,
    mode: config.mode,
    result: 'ok',
    status: 200,
  });
}

/**
 * ADR-0018: notes 解決に渡すインデックスを deny 除外ビューへ差し替える。
 * listNotes / queryNotes の両方から isDenied 対象のノートを除く
 * (pin フォルダ配下・query 結果いずれも機密ノートを一覧に出さない)。
 */
function denyFilteredIndex(
  index: VaultIndex,
  isDenied: (relPath: string) => boolean,
): Pick<VaultIndex, 'listNotes' | 'queryNotes'> {
  return {
    listNotes(filter): NoteMeta[] {
      return index.listNotes(filter).filter((n) => !isDenied(n.path));
    },
    queryNotes() {
      return index.queryNotes().filter((n) => !isDenied(n.path));
    },
  };
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * スマートフォルダ操作ツールを生成する (ADR-0016)。caps に含まれるケーパビリティに
 * 対応するツールだけを配列へ入れて返す (無効なら広告されない)。
 *
 * @param config    ServerConfig (vaultRoot / mode)。サービス層・audit に渡す。
 * @param index     VaultIndex。notes 解決 (deny 除外ビュー経由) に使う。
 * @param isDenied  ADR-0018 機密領域 deny 判定。
 * @param caps      実効ケーパビリティ (ADR-0015)。
 */
export function createSmartFolderTools(
  config: ServerConfig,
  index: VaultIndex,
  isDenied: (relPath: string) => boolean,
  caps: readonly Capability[],
): ReturnType<typeof defineTool>[] {
  const vaultRoot = config.vaultRoot;
  const capSet = new Set<Capability>(caps);
  const tools: ReturnType<typeof defineTool>[] = [];

  // ---- smartfolders_list (read) ---------------------------------------------

  if (capSet.has('read')) {
    tools.push(
      defineTool({
        name: 'smartfolders_list',
        label: 'スマートフォルダ一覧',
        description:
          'vault に定義されたスマートフォルダ (ビュー定義) の一覧を返す。' +
          '各項目の id・name・kind (query|pin)・DQL または pin パスを表示する。入力なし。',
        parameters: Type.Object({}),
        async execute(): Promise<ToolResult> {
          const cfg = await readSmartFoldersConfig(vaultRoot);
          if (cfg.items.length === 0) {
            return textResult('スマートフォルダは定義されていません。', { count: 0 });
          }
          const lines = cfg.items.map((item) => {
            const detail = item.kind === 'query' ? `dql: ${item.dql}` : `path: ${item.path}`;
            const name = item.name !== undefined && item.name !== '' ? item.name : '(名前なし)';
            return `- ${item.id} — ${name} [${item.kind}] ${detail}`;
          });
          return textResult(
            `スマートフォルダ (${String(cfg.items.length)} 件):\n${lines.join('\n')}`,
            { count: cfg.items.length },
          );
        },
      }),
    );

    // ---- smartfolder_notes (read) -------------------------------------------

    tools.push(
      defineTool({
        name: 'smartfolder_notes',
        label: 'スマートフォルダの解決',
        description:
          '指定 id のスマートフォルダを解決し、含まれるノートのパス一覧を返す。' +
          'query は DQL を実行、pin はノート/フォルダ配下を解決する。' +
          '機密領域のノートは一覧に含まれない。id が存在しない場合はその旨を返す。',
        parameters: Type.Object({
          id: Type.String({ description: 'スマートフォルダ id (smartfolders_list で確認)' }),
        }),
        async execute(_id, params): Promise<ToolResult> {
          // ADR-0018: deny 除外ビュー経由で解決する (機密ノートを漏らさない)。
          const view = denyFilteredIndex(index, isDenied);
          const resolved = await resolveSmartFolderNotes(vaultRoot, view, params.id);
          if (!resolved.ok) {
            if (resolved.reason === 'not_found') {
              // id 不明は throw せず not-found 相当のテキストで返す。
              return textResult(`スマートフォルダが見つかりません: ${params.id}`, {
                error: true,
                id: params.id,
              });
            }
            return textResult(
              `スマートフォルダの DQL が不正です: ${resolved.message}`,
              { error: true, id: params.id },
            );
          }
          if (resolved.notes.length === 0) {
            return textResult(`スマートフォルダ "${params.id}" に一致するノートはありません。`, {
              count: 0,
              id: params.id,
            });
          }
          const lines = resolved.notes.map((n) => `- [[${n.path.replace(/\.md$/, '')}]]`);
          return textResult(
            `スマートフォルダ "${params.id}" のノート (${String(resolved.notes.length)} 件):\n${lines.join('\n')}`,
            { count: resolved.notes.length, id: params.id },
          );
        },
      }),
    );
  }

  // ---- smartfolder_write (smartfolder_write) --------------------------------

  if (capSet.has('smartfolder_write')) {
    tools.push(
      defineTool({
        name: 'smartfolder_write',
        label: 'スマートフォルダ作成/更新',
        description:
          'スマートフォルダ (DQL ビュー定義) を作成または更新する (id 既存なら上書き)。' +
          'dql は Loamium DQL (LIST / TABLE / TASK)。system/smart-folders/{id}.yaml として保存する。',
        parameters: Type.Object({
          id: Type.String({ description: 'スマートフォルダ id (ファイル名。例: "projects")' }),
          name: Type.String({ description: '表示名' }),
          dql: Type.String({ description: 'DQL クエリ (例: LIST FROM #project)' }),
          icon: Type.Optional(Type.String({ description: 'アイコン名 (任意)' })),
        }),
        async execute(_id, params): Promise<ToolResult> {
          // DQL 構文を事前検証する (保存前に不正 DQL を弾く / REST の PUT スキーマと同じ検証)。
          try {
            parseQuery(params.dql);
          } catch (err) {
            if (err instanceof DqlParseError) {
              return textResult(`DQL 構文エラー: ${err.message}`, { error: true, id: params.id });
            }
            return textResult(`DQL 検証エラー: ${String(err)}`, { error: true, id: params.id });
          }

          // REST の PUT と同一の YAML 直列化を再利用する (serializeSmartFolderYaml)。
          const item: SmartViewQueryItem = {
            kind: 'query',
            id: params.id,
            name: params.name,
            dql: params.dql,
            ...(params.icon !== undefined && params.icon !== '' ? { icon: params.icon } : {}),
          };
          const yamlText = serializeSmartFolderYaml(item);

          // writeSystemSmartFolder が normalizeSystemPath で id を検証する
          // (../ / 隠しセグメント脱出を拒否 → VaultPathError)。
          let result: { created: boolean; mtime: number };
          try {
            result = await writeSystemSmartFolder(vaultRoot, params.id, yamlText);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return textResult(`パスエラー: ${err.message}`, { error: true, id: params.id });
            }
            return textResult(`スマートフォルダの書き込みに失敗しました: ${String(err)}`, {
              error: true,
              id: params.id,
            });
          }

          await audit(config, 'agent.smartfolder_write', params.id);
          const verb = result.created ? '作成' : '更新';
          return textResult(`スマートフォルダを${verb}しました: ${params.id}`, {
            id: params.id,
            created: result.created,
          });
        },
      }),
    );

    // ---- smartfolder_delete (smartfolder_write) -----------------------------

    tools.push(
      defineTool({
        name: 'smartfolder_delete',
        label: 'スマートフォルダ削除',
        description:
          '指定 id のスマートフォルダ (query 定義) を削除する。' +
          '存在しない id はエラーにせず「削除対象なし」を返す。',
        parameters: Type.Object({
          id: Type.String({ description: '削除するスマートフォルダ id' }),
        }),
        async execute(_id, params): Promise<ToolResult> {
          let deleted: boolean;
          try {
            deleted = await deleteSystemSmartFolder(vaultRoot, params.id);
          } catch (err) {
            if (err instanceof VaultPathError) {
              return textResult(`パスエラー: ${err.message}`, { error: true, id: params.id });
            }
            return textResult(`スマートフォルダの削除に失敗しました: ${String(err)}`, {
              error: true,
              id: params.id,
            });
          }
          if (!deleted) {
            // 存在しない id はエラーにしない (削除対象なし)。監査は残さない。
            return textResult(`削除対象なし: ${params.id}`, { id: params.id });
          }
          await audit(config, 'agent.smartfolder_delete', params.id);
          return textResult(`スマートフォルダを削除しました: ${params.id}`, { id: params.id });
        },
      }),
    );
  }

  return tools;
}

/** スマートフォルダツール名の固定セット (ADR-0015 deriveToolNames と一致)。sorted。 */
export const SMART_FOLDER_TOOL_NAMES = [
  'smartfolder_delete',
  'smartfolder_notes',
  'smartfolder_write',
  'smartfolders_list',
] as const;
