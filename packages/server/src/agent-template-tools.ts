/**
 * Loamium エージェント用テンプレート操作ツール群 (Sc4b9d1-3 / ADR-0016)。
 *
 * ADR-0016 契約: テンプレートの一覧化・解決/インスタンス化は **REST と同一のサービス層**
 * (templates-service.ts) を経由する。エージェント専用の独自解決ロジックは新設しない。
 *
 * ツール分類とケーパビリティ (ADR-0015):
 *   - templates_list       : 読み取り系 → read ケーパビリティ (壊れたテンプレートはスキップ)。
 *   - template_instantiate : テンプレート適用でノート生成 (= 書き込み系) → 既存 template_write
 *     ケーパビリティを再利用する (decisions)。clampByMode で書込モード整合 (full のみ)。
 *
 * 共通制約 (他ツールと同じ規約):
 *   - execute() は throw せず、エラー時は content テキストで返す。
 *   - 結果ノートはピュア Markdown (buildBodyTemplate が loamium-template 記法を除去。
 *     DESIGN_PRINCIPLES priority 1)。
 *   - 保存先は pathMode 解決後 normalizeVaultPath 検証、衝突は firstFreePath (REST と同一)。
 *   - 生成成功時に op: agent.template_instantiate を直接監査へ記録する (HTTP を通らないため)。
 *
 * caps に含まれるツールだけを生成して返す (無効なら広告されない)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Capability } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { writeAuditEntry } from './audit.js';
import { instantiateTemplate, listTemplates } from './templates-service.js';

// ---- 型エイリアス --------------------------------------------------------------

type ToolDetails = { error?: boolean; count?: number; path?: string; created?: boolean };

type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * テンプレート操作ツールを生成する (ADR-0016)。caps に含まれるケーパビリティに
 * 対応するツールだけを配列へ入れて返す (無効なら広告されない)。
 *
 * @param config   ServerConfig (vaultRoot / mode)。サービス層・audit に渡す。
 * @param isDenied ADR-0018 機密領域 deny 判定。template_instantiate の解決保存先を
 *                 書き込み直前に判定し、deny なら明示エラーで拒否する (agent 境界の
 *                 関心事。REST は instantiateTemplate に渡さないため deny 無し)。
 * @param caps     実効ケーパビリティ (ADR-0015)。
 */
export function createTemplateTools(
  config: ServerConfig,
  isDenied: (relPath: string) => boolean,
  caps: readonly Capability[],
  vaultIndex?: VaultIndex,
): ReturnType<typeof defineTool>[] {
  const vaultRoot = config.vaultRoot;
  const capSet = new Set<Capability>(caps);
  const tools: ReturnType<typeof defineTool>[] = [];

  // ---- templates_list (read) ------------------------------------------------

  if (capSet.has('read')) {
    tools.push(
      defineTool({
        name: 'templates_list',
        label: 'テンプレート一覧',
        description:
          'vault に定義されたテンプレート (system/templates/ 優先, fallback: templates/) の' +
          '一覧を返す。各項目の name (instantiate に使う識別子)・説明・保存先パターン・変数を表示する。' +
          '壊れたテンプレートはスキップする。入力なし。',
        parameters: Type.Object({}),
        async execute(): Promise<ToolResult> {
          // GET /api/templates と同一経路: listTemplates (system/ 優先・壊れはスキップ)。
          const templates = await listTemplates(vaultRoot);
          if (templates.length === 0) {
            return textResult('テンプレートは定義されていません。', { count: 0 });
          }
          const lines = templates.map((t) => {
            const desc = t.description !== undefined && t.description !== '' ? ` — ${t.description}` : '';
            const target = t.target !== undefined ? ` [保存先: ${t.target}]` : '';
            const required = t.vars.filter((v) => v.required === true).map((v) => v.name);
            const req = required.length > 0 ? ` [必須変数: ${required.join(', ')}]` : '';
            return `- ${t.name}${desc}${target}${req}`;
          });
          return textResult(
            `テンプレート (${String(templates.length)} 件):\n${lines.join('\n')}`,
            { count: templates.length },
          );
        },
      }),
    );
  }

  // ---- template_instantiate (template_write) --------------------------------

  if (capSet.has('template_write')) {
    tools.push(
      defineTool({
        name: 'template_instantiate',
        label: 'テンプレート適用',
        description:
          '指定 name のテンプレートを解決し、変数を埋めて新規ノートを生成する ' +
          '(POST /api/templates/{name}/instantiate と同一解決エンジン)。' +
          'vars は変数名→値マップ。date (YYYY-MM-DD) は {{date}} の基準日 (省略時は今日)。' +
          '必須変数不足は missing 一覧を返す。保存先が衝突する場合は連番で回避する。' +
          '結果ノートはピュア Markdown (テンプレート記法は残らない)。',
        parameters: Type.Object({
          name: Type.String({ description: 'テンプレート name (templates_list で確認)' }),
          vars: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: '変数名→値マップ (省略可)',
            }),
          ),
          date: Type.Optional(
            Type.String({ description: '{{date}} の基準日 (YYYY-MM-DD、省略時は今日)' }),
          ),
        }),
        async execute(_id, params): Promise<ToolResult> {
          const vars: Record<string, string> = params.vars ?? {};
          // REST と同一の解決エンジンへ委譲する (templates-service.instantiateTemplate)。
          // ADR-0018: agent 経路なので isDenied を渡し、解決保存先の deny を強制する。
          const outcome = await instantiateTemplate(
            config,
            params.name,
            vars,
            params.date,
            isDenied,
            vaultIndex,
          );

          switch (outcome.status) {
            case 'invalid_date':
              return textResult(`日付が不正です: ${outcome.message}`, { error: true });
            case 'not_found':
              return textResult(`テンプレートが見つかりません: ${params.name}`, { error: true });
            case 'missing_vars':
              return textResult(
                `必須変数が不足しています: ${outcome.missing.join(', ')}`,
                { error: true },
              );
            case 'invalid_target':
              return textResult(`保存先パスが不正です: ${outcome.message}`, { error: true });
            case 'denied':
              return textResult(`機密領域への保存は拒否されました: ${outcome.message}`, {
                error: true,
              });
            case 'invalid_select_value':
              // ADR-0031: select+optionsQuery の候補外の値
              return textResult(
                `パラメータ '${outcome.paramName}' の値が候補外です: ${outcome.message}`,
                { error: true },
              );
            case 'ok': {
              // HTTP を通らないため op: agent.template_instantiate を直接監査へ記録する。
              await writeAuditEntry(config, {
                ts: new Date().toISOString(),
                op: 'agent.template_instantiate',
                path: outcome.path,
                mode: config.mode,
                result: 'ok',
                status: 200,
              });
              return textResult(
                `テンプレート "${params.name}" からノートを生成しました: ${outcome.path}`,
                { path: outcome.path, created: true },
              );
            }
          }
        },
      }),
    );
  }

  return tools;
}

/** テンプレートツール名の固定セット (ADR-0015 deriveToolNames と一致)。sorted。 */
export const TEMPLATE_TOOL_NAMES = ['template_instantiate', 'templates_list'] as const;
