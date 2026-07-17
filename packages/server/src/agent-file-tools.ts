/**
 * Loamium エージェント用 添付ファイル操作ツール群 (agent-write-coverage / ADR-0016)。
 *
 * ADR-0016 契約: 添付ファイル (非 .md) の作成/上書き・リネーム/移動 (![[リンク]] 追従)・
 * 削除は **REST と同一のサービス層** (file-service.ts) を経由する。エージェント専用の
 * 独自ファイル操作・独自フォーマットは新設しない (二重管理の排除)。
 *
 * ツール分類とケーパビリティ (ADR-0015):
 *   - file_write  : 添付の作成/上書き (writeAttachment)  → file_write ケーパビリティ
 *   - file_move   : 添付のリネーム/移動 (moveAttachment) → file_write ケーパビリティ
 *   - file_delete : 添付の削除 (deleteAttachment)         → file_write ケーパビリティ
 * file_write ケーパビリティは全 file 系書き込みを畳む独立ケーパビリティで full のみ許可
 * (clampByMode / MODE_ALLOWED に含めない = 書込モードのみ広告)。
 *
 * 共通制約 (他書き込みツールと同じ規約):
 *   - normalizeVaultFilePath で `..` / vault 外 / 隠しセグメント (.loamium 等) を拒否。
 *     .md への書き込みは notes API へ誘導 (拒否)。
 *   - isDenied (ADR-0018 privacy deny) にマッチするパスは拒否 (deny > allow)。move は両端。
 *   - execute() は throw せず、エラー時は content テキストで返す。
 *   - 成功時に writeAuditEntry を直接呼ぶ (Hono middleware を通らないため /
 *     op: agent.file_write | agent.file_move | agent.file_delete)。
 *
 * エージェントはテキストしか渡せないため content は文字列。encoding='base64' で
 * バイナリ添付も書ける。サイズ上限 (LOAMIUM_MAX_UPLOAD) 超過はエラー。
 *
 * caps に含まれるツールだけを生成して返す (無効なら広告されない)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { normalizeVaultFilePath, VaultPathError, type Capability } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { writeAuditEntry } from './audit.js';
import { deleteAttachment, moveAttachment, writeAttachment } from './file-service.js';

// ---- 型エイリアス --------------------------------------------------------------

type ToolDetails = { error?: boolean; created?: boolean; deleted?: boolean; path?: string };

type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

/**
 * 添付パスを normalizeVaultFilePath + isDenied で検証する。
 * - VaultPathError (`..` / vault 外 / 隠しセグメント / 空) → エラーテキスト。
 * - .md への書き込みは notes API へ誘導する (添付 API では扱わない)。
 * - isDenied (privacy deny) にマッチ → 拒否 (存在ごと隠す)。
 */
function resolveAttachmentPath(
  rawPath: string,
  isDenied: (relPath: string) => boolean,
): { ok: true; rel: string } | { ok: false; result: ToolResult } {
  let rel: string;
  try {
    rel = normalizeVaultFilePath(rawPath);
  } catch (err) {
    if (err instanceof VaultPathError) {
      return { ok: false, result: textResult(`パスエラー: ${err.message}`, { error: true }) };
    }
    return { ok: false, result: textResult(`パス正規化エラー: ${String(err)}`, { error: true }) };
  }
  if (rel.toLowerCase().endsWith('.md')) {
    return {
      ok: false,
      result: textResult(
        `.md はノート API で管理されます (note_create / note_edit / note_move を使ってください): ${rel}`,
        { error: true, path: rel },
      ),
    };
  }
  if (isDenied(rel)) {
    return { ok: false, result: textResult(`書き込みできません: ${rel}`, { error: true }) };
  }
  return { ok: true, rel };
}

/** 書き込み成功時に監査ログへ 1 エントリ直接記録する (op: agent.<tool>)。 */
async function audit(config: ServerConfig, op: string, rel: string): Promise<void> {
  await writeAuditEntry(config, {
    ts: new Date().toISOString(),
    op,
    path: rel,
    mode: config.mode,
    result: 'ok',
    status: 200,
  });
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * 添付ファイル操作ツールを生成する (ADR-0016)。file_write ケーパビリティが有効なとき
 * だけ file_write / file_move / file_delete を配列へ入れて返す (無効なら広告されない)。
 *
 * @param config   ServerConfig (vaultRoot / mode / maxUploadBytes)。file-service・audit に渡す。
 * @param index    VaultIndex。file_move のリネーム後インデックス即時追従に渡す。
 * @param isDenied ADR-0018 機密領域 deny 判定。
 * @param caps     実効ケーパビリティ (ADR-0015)。
 */
export function createFileTools(
  config: ServerConfig,
  index: VaultIndex,
  isDenied: (relPath: string) => boolean,
  caps: readonly Capability[],
): ReturnType<typeof defineTool>[] {
  const capSet = new Set<Capability>(caps);
  const tools: ReturnType<typeof defineTool>[] = [];

  if (!capSet.has('file_write')) return tools;

  // ---- file_write (作成/上書き) ---------------------------------------------

  tools.push(
    defineTool({
      name: 'file_write',
      label: '添付ファイル作成/上書き',
      description:
        'vault 内に添付ファイル (非 .md) を作成または上書きする (POST /api/files/{path} と同一のコア)。' +
        'content はテキスト (encoding: "utf8" 既定)。バイナリ (画像等) は encoding: "base64" で渡す。' +
        '既定では既存を上書きしない (overwrite: true を指定したときのみ既存を置き換える)。' +
        'サイズ上限 (LOAMIUM_MAX_UPLOAD) 超過はエラー。.md はノート API 側で扱う (ここでは拒否)。',
      parameters: Type.Object({
        path: Type.String({ description: 'vault 相対パス (例: "assets/diagram.svg")' }),
        content: Type.String({ description: 'ファイル内容 (テキスト。base64 でバイナリも可)' }),
        encoding: Type.Optional(
          Type.Union([Type.Literal('utf8'), Type.Literal('base64')], {
            description: 'content のエンコーディング (既定 utf8)',
          }),
        ),
        overwrite: Type.Optional(
          Type.Boolean({ description: 'true なら既存を上書きする (既定 false)' }),
        ),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const resolved = resolveAttachmentPath(params.path, isDenied);
        if (!resolved.ok) return resolved.result;
        const encoding = params.encoding ?? 'utf8';
        const data = Buffer.from(params.content, encoding);
        const result = await writeAttachment(config, resolved.rel, data, params.overwrite === true);
        if (!result.ok) {
          if (result.reason === 'too_large') {
            return textResult(`サイズ上限を超えています: ${result.message}`, {
              error: true,
              path: resolved.rel,
            });
          }
          if (result.message.startsWith('file already exists')) {
            return textResult(
              `ファイルは既に存在します (上書きするには overwrite:true): ${resolved.rel}`,
              { error: true, path: resolved.rel },
            );
          }
          return textResult(`書き込みに失敗しました: ${result.message}`, {
            error: true,
            path: resolved.rel,
          });
        }
        await audit(config, 'agent.file_write', resolved.rel);
        const verb = result.created ? '作成' : '上書き';
        return textResult(`添付ファイルを${verb}しました: ${resolved.rel}`, {
          path: resolved.rel,
          created: result.created,
        });
      },
    }),
  );

  // ---- file_move (リネーム/移動) --------------------------------------------

  tools.push(
    defineTool({
      name: 'file_move',
      label: '添付ファイルのリネーム/移動',
      description:
        '既存の添付ファイルをリネーム/移動する (POST /api/files/{path}/rename と同一のコア)。' +
        'vault 全体の ![[旧名]] 埋め込みリンクを新パスへ一括追従する。' +
        '移動先が既に存在する場合はエラー (上書きしない)。from が存在しない場合もエラー。' +
        'from/to どちらかが機密領域 (deny) / .md なら拒否する。',
      parameters: Type.Object({
        from: Type.String({ description: '移動元の vault 相対パス (既存の添付)' }),
        to: Type.String({ description: '移動先の vault 相対パス' }),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const src = resolveAttachmentPath(params.from, isDenied);
        if (!src.ok) return src.result;
        const dst = resolveAttachmentPath(params.to, isDenied);
        if (!dst.ok) return dst.result;
        const result = await moveAttachment(config, index, src.rel, dst.rel);
        if (!result.ok) {
          if (result.reason === 'not_found') {
            return textResult(`ファイルが見つかりません: ${src.rel}`, {
              error: true,
              path: src.rel,
            });
          }
          if (result.reason === 'conflict') {
            return textResult(`移動先が既に存在します (上書きしません): ${dst.rel}`, {
              error: true,
              path: dst.rel,
            });
          }
          return textResult(`リネーム中に中断しました: ${result.message}`, {
            error: true,
            path: dst.rel,
          });
        }
        await audit(config, 'agent.file_move', result.path);
        return textResult(
          `添付ファイルを移動しました: ${result.oldPath} → ${result.path} ` +
            `(追従リンク ${String(result.updatedLinks)} 箇所)`,
          { path: result.path },
        );
      },
    }),
  );

  // ---- file_delete (削除) ----------------------------------------------------

  tools.push(
    defineTool({
      name: 'file_delete',
      label: '添付ファイル削除',
      description:
        'vault 内の既存の添付ファイルを削除する (DELETE /api/files/{path} と同一のコア)。' +
        '**この操作は不可逆です** (vault は Git 管理前提で復旧は git に依存)。' +
        '存在しない path はエラーにせず「削除対象なし」を返す。機密領域 (deny) / .md は拒否する。',
      parameters: Type.Object({
        path: Type.String({ description: '削除する vault 相対パス (添付)' }),
      }),
      async execute(_id, params): Promise<ToolResult> {
        const resolved = resolveAttachmentPath(params.path, isDenied);
        if (!resolved.ok) return resolved.result;
        const { deleted } = await deleteAttachment(config, resolved.rel);
        if (!deleted) {
          // 存在しない path はエラーにしない (削除対象なし)。監査は残さない。
          return textResult(`削除対象なし: ${resolved.rel}`, { path: resolved.rel });
        }
        await audit(config, 'agent.file_delete', resolved.rel);
        return textResult(`添付ファイルを削除しました: ${resolved.rel}`, {
          path: resolved.rel,
          deleted: true,
        });
      },
    }),
  );

  return tools;
}

/** 添付ファイルツール名の固定セット (ADR-0015 deriveToolNames と一致)。sorted。 */
export const FILE_TOOL_NAMES = ['file_delete', 'file_move', 'file_write'] as const;
