/**
 * Loamium エージェント用書き込みツール群 (S5bd678-2 / ADR-0016)。
 *
 * ADR-0016 契約: 書き込みケーパビリティは **REST と同一のサービス層** (note-service.ts:
 * PUT/POST/append/patch と同じコード) を呼ぶツールとして実装する。これで
 * ピュア Markdown 出力・normalizeVaultPath・.loamium/audit.log・[[リンク]] を
 * 自動継承する。エージェント専用の書き込み実装は新設しない (二重管理の排除)。
 *
 * - Template 作成 = templates/ 配下に規定 frontmatter を持つ**通常ノート**を書く。
 * - DataView 作成 = ノート本文に ```dataview フェンスを書く。
 * どちらも新フォーマットではない。ブロック ID・独自記法・非 Markdown 構造は書かない。
 *
 * 全ツール共通制約 (read ツールと同じ規約):
 * - normalizeVaultPath で `..` / vault 外 / 隠しセグメント (.loamium 等) を拒否。
 * - isDenied (ADR-0018 機密領域 privacy deny) にマッチするパスは拒否 (deny > allow)。
 * - execute() は throw せず、エラー時は content テキストで返す。
 * - 成功時に writeAuditEntry(config, ...) を**直接**呼ぶ (Hono middleware を通らないため)。
 *
 * caps (有効ケーパビリティ) に含まれる書き込みツールだけを生成して返す
 * (無効なら配列に入れない = LLM に広告されない、AC-S5bd678-2-2)。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  normalizeVaultPath,
  VaultPathError,
  JournalDateError,
  type Capability,
} from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import { writeAuditEntry } from './audit.js';
import {
  appendToJournal,
  appendToNote,
  createNote,
  patchNote,
  type WriteResult,
} from './note-service.js';

// ---- 型エイリアス --------------------------------------------------------------

/** 全ツールの details 型 (read ツールと同一の汎用形状)。 */
type ToolDetails = { error?: boolean; created?: boolean; path?: string };

type ToolResult = { content: { type: 'text'; text: string }[]; details: ToolDetails };

/** ツール結果を組み立てる共通ヘルパー (read ツールと同一)。 */
function textResult(text: string, details: ToolDetails = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details };
}

/**
 * パスを normalizeVaultPath + isDenied で検証する。
 * - VaultPathError (`..` / vault 外 / 隠しセグメント .loamium 等 / 空) → エラーテキスト。
 * - isDenied (privacy deny) にマッチ → not-found と同一の隠蔽文言で拒否 (存在ごと隠す)。
 */
function resolveWritablePath(
  rawPath: string,
  isDenied: (relPath: string) => boolean,
): { ok: true; rel: string } | { ok: false; result: ToolResult } {
  let rel: string;
  try {
    rel = normalizeVaultPath(rawPath);
  } catch (err) {
    if (err instanceof VaultPathError) {
      return { ok: false, result: textResult(`パスエラー: ${err.message}`, { error: true }) };
    }
    return { ok: false, result: textResult(`パス正規化エラー: ${String(err)}`, { error: true }) };
  }
  if (isDenied(rel)) {
    // ADR-0018: deny マッチは存在ごと隠す (deny > allow)。書き込みも拒否する。
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

/** WriteResult の失敗理由を人間可読なエラーテキストへ写像する。 */
function failText(result: Extract<WriteResult, { ok: false }>): ToolResult {
  return textResult(`書き込みに失敗しました: ${result.message}`, { error: true });
}

// ---- frontmatter 直列化 (ピュア Markdown) -------------------------------------

/**
 * template_write の規定 frontmatter を通常の Markdown YAML frontmatter として直列化する。
 *
 * ピュア Markdown 絶対: 独自記法・ブロック ID を書かない。frontmatter は
 * `---` で囲む標準の YAML ブロックのみ。値はスカラー (文字列/数値/真偽) を
 * ダブルクォートで安全にエスケープして書く (配列/ネストは受けない — 単純さ優先)。
 */
function serializeFrontmatter(fm: Record<string, string | number | boolean>): string {
  const lines = Object.entries(fm).map(([key, value]) => {
    if (typeof value === 'string') {
      // YAML の安全なダブルクォート表現 (\ と " をエスケープ)。
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    }
    return `${key}: ${String(value)}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * 書き込みツールを生成する (ADR-0016)。caps に含まれる書き込みケーパビリティに
 * 対応するツールだけを配列へ入れて返す (無効なら広告されない)。
 *
 * @param config    ServerConfig (vaultRoot / mode)。note-service と audit に渡す。
 * @param _index    VaultIndex (将来のインデックス即時追従用に予約。現状ツール本体では未使用)。
 * @param isDenied  ADR-0018 機密領域 deny 判定。
 * @param caps      実効ケーパビリティ (ADR-0015)。
 */
export function createVaultWriteTools(
  config: ServerConfig,
  _index: VaultIndex,
  isDenied: (relPath: string) => boolean,
  caps: readonly Capability[],
) {
  const capSet = new Set<Capability>(caps);
  const tools: ReturnType<typeof defineTool>[] = [];

  // ---- journal_append ---------------------------------------------------------

  if (capSet.has('journal_append')) {
    tools.push(
      defineTool({
        name: 'journal_append',
        label: 'ジャーナル追記',
        description:
          'デイリージャーナル (journals/YYYY/MM/YYYY-MM-DD.md) の末尾に Markdown テキストを追記する。' +
          'date 省略時は今日。ジャーナルが無ければ作成して追記する。',
        parameters: Type.Object({
          text: Type.String({ description: '追記する Markdown テキスト' }),
          date: Type.Optional(
            Type.String({ description: '対象日 YYYY-MM-DD (省略時は今日)' }),
          ),
        }),
        async execute(_id, params): Promise<ToolResult> {
          let out;
          try {
            out = await appendToJournal(config, params.date ?? null, params.text);
          } catch (err) {
            if (err instanceof JournalDateError) {
              return textResult(`日付エラー: ${err.message}`, { error: true });
            }
            return textResult(`ジャーナル追記エラー: ${String(err)}`, { error: true });
          }
          await audit(config, 'agent.journal_append', out.rel);
          const details: ToolDetails = { path: out.rel };
          if (out.result.ok) details.created = out.result.created;
          return textResult(`ジャーナルに追記しました: ${out.rel}`, details);
        },
      }),
    );
  }

  // ---- note_create ------------------------------------------------------------

  if (capSet.has('note_create')) {
    tools.push(
      defineTool({
        name: 'note_create',
        label: 'ノート新規作成',
        description:
          'vault 内に新しいノートを作成する。content はピュア Markdown。' +
          '対象パスが既に存在する場合は作成せずエラーを返す (上書きしない)。',
        parameters: Type.Object({
          path: Type.String({ description: 'vault 相対パス (例: "project/idea")' }),
          content: Type.String({ description: 'ノート本文 (ピュア Markdown)' }),
        }),
        async execute(_id, params): Promise<ToolResult> {
          const resolved = resolveWritablePath(params.path, isDenied);
          if (!resolved.ok) return resolved.result;
          const result = await createNote(config, resolved.rel, params.content);
          if (!result.ok) {
            if (result.reason === 'exists') {
              return textResult(`ノートは既に存在します (上書きしません): ${resolved.rel}`, {
                error: true,
                path: resolved.rel,
              });
            }
            return failText(result);
          }
          await audit(config, 'agent.note_create', resolved.rel);
          return textResult(`ノートを作成しました: ${resolved.rel}`, {
            path: resolved.rel,
            created: true,
          });
        },
      }),
    );
  }

  // ---- note_edit --------------------------------------------------------------

  if (capSet.has('note_edit')) {
    tools.push(
      defineTool({
        name: 'note_edit',
        label: 'ノート編集',
        description:
          '既存ノートの一部を old→new で置換する (非破壊 patch)。old はノート内で一意に' +
          '一致する必要がある。old が見つからない / 複数箇所に一致する場合はエラーを返す。',
        parameters: Type.Object({
          path: Type.String({ description: 'vault 相対パス' }),
          old: Type.String({ description: '置換対象の既存テキスト (ノート内で一意)' }),
          new: Type.String({ description: '置換後のテキスト' }),
        }),
        async execute(_id, params): Promise<ToolResult> {
          const resolved = resolveWritablePath(params.path, isDenied);
          if (!resolved.ok) return resolved.result;
          const result = await patchNote(config, resolved.rel, params.old, params.new);
          if (!result.ok) return failText(result);
          await audit(config, 'agent.note_edit', resolved.rel);
          return textResult(`ノートを編集しました: ${resolved.rel}`, { path: resolved.rel });
        },
      }),
    );
  }

  // ---- template_write ---------------------------------------------------------

  if (capSet.has('template_write')) {
    tools.push(
      defineTool({
        name: 'template_write',
        label: 'テンプレート作成',
        description:
          'templates/ 配下に新しいテンプレートノートを作成する。frontmatter は通常の Markdown ' +
          'YAML フロントマター (独自記法なし)。body はピュア Markdown。既存テンプレートは上書きしない。',
        parameters: Type.Object({
          name: Type.String({ description: 'テンプレート名 (例: "meeting")。templates/<name>.md に作成' }),
          body: Type.String({ description: 'テンプレート本文 (ピュア Markdown)' }),
          frontmatter: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
              { description: 'frontmatter キー→スカラー値マップ (任意)' },
            ),
          ),
        }),
        async execute(_id, params): Promise<ToolResult> {
          // templates/<name>.md を組み立てる。name 自体もパス検証を通す
          // (`../` や `templates/..` 脱出、隠しセグメントを拒否)。
          const resolved = resolveWritablePath(`templates/${params.name}`, isDenied);
          if (!resolved.ok) return resolved.result;
          // 規定 frontmatter (type: template) を必ず付与し、呼び出し側指定をマージする。
          const fm: Record<string, string | number | boolean> = {
            type: 'template',
            ...(params.frontmatter ?? {}),
          };
          const content = serializeFrontmatter(fm) + (params.body.length > 0 ? `\n${params.body}` : '');
          const result = await createNote(config, resolved.rel, content);
          if (!result.ok) {
            if (result.reason === 'exists') {
              return textResult(`テンプレートは既に存在します (上書きしません): ${resolved.rel}`, {
                error: true,
                path: resolved.rel,
              });
            }
            return failText(result);
          }
          await audit(config, 'agent.template_write', resolved.rel);
          return textResult(`テンプレートを作成しました: ${resolved.rel}`, {
            path: resolved.rel,
            created: true,
          });
        },
      }),
    );
  }

  // ---- dataview_write ---------------------------------------------------------

  if (capSet.has('dataview_write')) {
    tools.push(
      defineTool({
        name: 'dataview_write',
        label: 'DataView 挿入',
        description:
          '既存ノートの末尾に ```dataview コードフェンス (DQL クエリ) を挿入する。' +
          '通常の Markdown コードフェンスとして書く (独自記法なし)。対象ノートは既存であること。',
        parameters: Type.Object({
          path: Type.String({ description: 'vault 相対パス (既存ノート)' }),
          query: Type.String({ description: 'DQL クエリ本文 (例: LIST FROM #tag)' }),
        }),
        async execute(_id, params): Promise<ToolResult> {
          const resolved = resolveWritablePath(params.path, isDenied);
          if (!resolved.ok) return resolved.result;
          // ピュア Markdown コードフェンス。query 末尾の改行は appendToNote が整える。
          const fence = '```dataview\n' + params.query.replace(/\n+$/, '') + '\n```\n';
          const result = await appendToNote(config, resolved.rel, fence);
          if (!result.ok) return failText(result);
          await audit(config, 'agent.dataview_write', resolved.rel);
          return textResult(`DataView を挿入しました: ${resolved.rel}`, { path: resolved.rel });
        },
      }),
    );
  }

  return tools;
}

/** 書き込みツール名の固定セット (ADR-0015 deriveToolNames と一致)。sorted。 */
export const VAULT_WRITE_TOOL_NAMES = [
  'dataview_write',
  'journal_append',
  'note_create',
  'note_edit',
  'template_write',
] as const;
