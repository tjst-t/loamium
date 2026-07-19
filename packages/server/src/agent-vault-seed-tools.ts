/**
 * Loamium エージェント用 vault_seed ツール (S7e2d5c-1 / ADR-0016)。
 *
 * ADR-0016 契約: vault_seed は SeedService (seed-service.ts) を経由する。
 * REST の POST /api/vault/seed と同一のコードパスを使い、二重管理を排除する。
 * エージェント専用の直接ファイルコピーは新設しない。
 *
 * ADR-0015 契約: vault_seed ケーパビリティが有効なときのみ広告する (write-only)。
 * full 権限モードでのみ許可される (clampByMode で read-only/append-only では除外される)。
 *
 * 共通制約:
 * - execute() は throw せず、エラー時は content テキストで返す。
 * - 書き込み成功時に writeAuditEntry(config, ...) を直接呼ぶ (Hono middleware を通らないため)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Capability } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import { writeAuditEntry } from './audit.js';
import { seed } from './seed-service.js';

type ToolDetails = { error?: boolean; seeded?: number; skipped?: number };
type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

/**
 * vault_seed ツールを生成する。
 * caps に 'vault_seed' が含まれる場合のみ配列に追加して返す (ADR-0015)。
 */
export function createVaultSeedTool(
  config: ServerConfig,
  caps: readonly Capability[],
): ReturnType<typeof defineTool>[] {
  const capSet = new Set<Capability>(caps);
  const tools: ReturnType<typeof defineTool>[] = [];

  if (capSet.has('vault_seed')) {
    tools.push(
      defineTool({
        name: 'vault_seed',
        label: 'サンプル投入',
        description:
          'Loamium 同梱のサンプルファイル (テンプレート・スマートコマンド・' +
          'スマートフォルダ定義・機能ガイド Markdown) を vault へ投入する。' +
          '既定では既存ファイルを上書きしない (force:true 指定時のみ上書き)。' +
          'POST /api/vault/seed と同一の SeedService を経由する (ADR-0016)。',
        parameters: Type.Object({
          force: Type.Optional(
            Type.Boolean({
              description: 'true なら既存ファイルを上書きする (既定 false: 既存はスキップ)',
            }),
          ),
        }),
        async execute(_id, params): Promise<ToolResult> {
          let result;
          try {
            result = await seed(config.vaultRoot, params.force ?? false);
          } catch (err) {
            return textResult(`サンプル投入エラー: ${String(err)}`, { error: true });
          }
          await writeAuditEntry(config, {
            ts: new Date().toISOString(),
            op: 'agent.vault_seed',
            path: config.vaultRoot,
            mode: config.mode,
            result: 'ok',
            status: 200,
          });
          const msg =
            `${String(result.seeded)} ファイルを vault に投入しました` +
            (result.skipped > 0 ? `（既存 ${String(result.skipped)} 件はスキップ）` : '');
          return textResult(msg, { seeded: result.seeded, skipped: result.skipped });
        },
      }),
    );
  }

  return tools;
}

/** vault_seed ツール名の固定セット (ADR-0015 deriveToolNames と一致)。 */
export const VAULT_SEED_TOOL_NAMES = ['vault_seed'] as const;
