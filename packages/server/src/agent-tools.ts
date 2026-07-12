/**
 * Loamium エージェント用読み取り専用ツール群 (S53409d-3 / ADR-0008)。
 *
 * ADR-0008 決定: エージェントに渡すツールは Loamium のノート操作 API のみ。
 * 第 1 リリースでは読み取り系 5 種のみ: search / query / read_note / backlinks / tags。
 * write 系ツールは別 Story で追加する。
 *
 * 全ツール共通制約:
 * - vault ルート外へのアクセスを禁止する (normalizeVaultPath)
 * - execute() は throw せず、エラー時は content テキストで返す
 * - VaultIndex の公開メソッドを直接呼ぶ (REST ルート経由ではない)
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  normalizeVaultPath,
  VaultPathError,
  parseQuery,
  executeQuery,
  DqlParseError,
} from '@loamium/shared';
import { readNote } from './vault.js';
import { resolveHelpTopic, helpTopicNames } from './agent-help.js';
import type { VaultIndex } from './noteIndex.js';
import { createPrivacyFilteredIndex } from './agent-privacy.js';

// ---- 型エイリアス ---------------------------------------------------------------

/** 全ツールの details 型 (シンプルに汎用化して union 問題を回避) */
type ToolDetails = { error?: boolean; count?: number; path?: string };

/** ツール結果を組み立てる共通ヘルパー */
function textResult(text: string, details: ToolDetails = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

// ---- ツールファクトリ ----------------------------------------------------------

/**
 * 5 種の読み取り専用ツールを生成する。
 * index と vaultRoot は各ツールのクロージャでキャプチャする。
 *
 * ADR-0014: isDenied は機密領域 deny 判定 (vault 相対パス → deny なら true)。
 * 省略時は「常に false」= deny なし (既存呼び出し・既存テスト非破壊)。
 * read_note は isDenied で未発見扱いにし、search/query/backlinks/tags は
 * createPrivacyFilteredIndex を通した共通フィルタビュー経由に統一する
 * (強制点をツールに散らさず 1 箇所へ集約する)。
 */
export function createVaultReadTools(
  index: VaultIndex,
  vaultRoot: string,
  isDenied: (relPath: string) => boolean = () => false,
) {
  // ADR-0014: read_note 以外のツールが参照するのは deny 除外済みの共通ビュー。
  const view = createPrivacyFilteredIndex(index, isDenied);

  // ---- search -----------------------------------------------------------------

  const searchTool = defineTool({
    name: 'search',
    label: '全文検索',
    description:
      'vault 内のノートを全文検索する。クエリに一致するノートのパス・タイトル・スニペットを返す。',
    parameters: Type.Object({
      query: Type.String({ description: '検索クエリ文字列' }),
    }),
    async execute(_toolCallId, params): Promise<{ content: { type: 'text'; text: string }[]; details: ToolDetails }> {
      const results = view.search(params.query, 20);
      if (results.length === 0) {
        return textResult(`"${params.query}" に一致するノートはありませんでした。`, { count: 0 });
      }
      const lines = results.map(
        (r) => `- [[${r.path.replace(/\.md$/, '')}]] (${r.title}) — ${r.snippet ?? r.title}`,
      );
      return textResult(`検索結果 (${String(results.length)} 件):\n${lines.join('\n')}`, { count: results.length });
    },
  });

  // ---- query ------------------------------------------------------------------

  const queryTool = defineTool({
    name: 'query',
    label: 'DQL クエリ',
    description:
      'Loamium DQL (LIST / TABLE / TASK) でノートをクエリする。フィルタ・ソート・タグ絞り込みが可能。',
    parameters: Type.Object({
      dql: Type.String({ description: 'DQL クエリ文字列 (例: LIST FROM #tag, TABLE title WHERE folder = "project")' }),
    }),
    async execute(_toolCallId, params): Promise<{ content: { type: 'text'; text: string }[]; details: ToolDetails }> {
      let result;
      try {
        result = executeQuery(parseQuery(params.dql), view.queryNotes());
      } catch (err) {
        if (err instanceof DqlParseError) {
          return textResult(`DQL 構文エラー: ${err.message}`, { error: true });
        }
        return textResult(`クエリ実行エラー: ${String(err)}`, { error: true });
      }

      if (result.type === 'list') {
        const items = result.results;
        if (items.length === 0) {
          return textResult('クエリに一致するノートはありませんでした。', { count: 0 });
        }
        const lines = items.map((row) => `- [[${row.path.replace(/\.md$/, '')}]]`);
        return textResult(`クエリ結果 (${String(items.length)} 件):\n${lines.join('\n')}`, { count: items.length });
      } else if (result.type === 'table') {
        const rows = result.results;
        if (rows.length === 0) {
          return textResult('クエリに一致するノートはありませんでした。', { count: 0 });
        }
        const headers = result.fields.join(' | ');
        const lines = rows.map((row) =>
          row.values.map((v) => (v === null ? '' : String(v))).join(' | '),
        );
        return textResult(
          `クエリ結果 (${String(rows.length)} 件):\n${headers}\n${lines.join('\n')}`,
          { count: rows.length },
        );
      } else {
        // task result
        const tasks = result.results;
        if (tasks.length === 0) {
          return textResult('クエリに一致するタスクはありませんでした。', { count: 0 });
        }
        const lines = tasks.map(
          (t) => `- [${t.checked ? 'x' : ' '}] ${t.text} ([[${t.path.replace(/\.md$/, '')}]])`,
        );
        return textResult(`タスク (${String(tasks.length)} 件):\n${lines.join('\n')}`, { count: tasks.length });
      }
    },
  });

  // ---- read_note --------------------------------------------------------------

  const readTool = defineTool({
    name: 'read_note',
    label: 'vault 内のノートを読む',
    description:
      'vault 内のノートを Markdown 原文で取得する。パスは vault ルートからの相対パス (.md 拡張子あり/なし両可)。',
    parameters: Type.Object({
      path: Type.String({ description: 'vault 相対パス (例: "project/design.md" / "project/design")' }),
    }),
    async execute(_toolCallId, params): Promise<{ content: { type: 'text'; text: string }[]; details: ToolDetails }> {
      let rel: string;
      try {
        rel = normalizeVaultPath(params.path);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return textResult(`パスエラー: ${err.message}`, { error: true });
        }
        return textResult(`パス正規化エラー: ${String(err)}`, { error: true });
      }
      // ADR-0014: deny マッチは存在ごと隠す — not-found と同一の文言/details で返す。
      if (isDenied(rel)) {
        return textResult(`ノートが見つかりません: ${rel}`, { error: true });
      }
      const content = await readNote(vaultRoot, rel);
      if (content === null) {
        return textResult(`ノートが見つかりません: ${rel}`, { error: true });
      }
      return textResult(content, { path: rel });
    },
  });

  // ---- backlinks --------------------------------------------------------------

  const backlinksTool = defineTool({
    name: 'backlinks',
    label: 'バックリンク',
    description:
      '指定ノートへのバックリンク (参照元) 一覧を返す。パスは vault ルートからの相対パス。',
    parameters: Type.Object({
      path: Type.String({ description: 'vault 相対パス (例: "project/design.md")' }),
    }),
    async execute(_toolCallId, params): Promise<{ content: { type: 'text'; text: string }[]; details: ToolDetails }> {
      let rel: string;
      try {
        rel = normalizeVaultPath(params.path);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return textResult(`パスエラー: ${err.message}`, { error: true });
        }
        return textResult(`パス正規化エラー: ${String(err)}`, { error: true });
      }
      const backlinks = view.backlinks(rel);
      if (backlinks.length === 0) {
        return textResult(`[[${rel.replace(/\.md$/, '')}]] へのバックリンクはありません。`, { count: 0 });
      }
      const lines = backlinks.flatMap((src) =>
        src.links.map((l) => `- [[${src.source.replace(/\.md$/, '')}]] L${String(l.line)}: ${l.context}`),
      );
      return textResult(
        `バックリンク (${String(backlinks.length)} 件の参照元):\n${lines.join('\n')}`,
        { count: backlinks.length },
      );
    },
  });

  // ---- tags -------------------------------------------------------------------

  const tagsTool = defineTool({
    name: 'tags',
    label: 'タグ一覧',
    description: 'vault 内で使われているタグの一覧と出現件数を返す。',
    parameters: Type.Object({}),
    async execute(): Promise<{ content: { type: 'text'; text: string }[]; details: ToolDetails }> {
      const tags = view.tags();
      if (tags.length === 0) {
        return textResult('vault にタグはありません。', { count: 0 });
      }
      const lines = tags.map((t) => `- ${t.tag} (${String(t.count)} 件)`);
      return textResult(`タグ一覧 (${String(tags.length)} 種):\n${lines.join('\n')}`, { count: tags.length });
    },
  });

  // ---- help -------------------------------------------------------------------
  //
  // S10a31c-2 / ADR-0010: DQL / テンプレート / DataView 等の詳細な使い方は
  // base システムプロンプトに常駐させず、この help ツールがトピック指定で供給する。
  // 読み取り系ツールに分類され (vault へ書き込まない)、read allowlist に含める。

  const helpTool = defineTool({
    name: 'help',
    label: 'Loamium ガイド',
    description:
      `Loamium の使い方ガイドをトピック指定で返す。トピック: ${helpTopicNames().join(', ')}。` +
      'topic を省略・未知トピック指定した場合は利用可能なトピック一覧を返す。DQL 文法・テンプレート・[[リンク]]・ジャーナル等を調べたいときに使う。',
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({ description: `ガイドトピック名 (例: ${helpTopicNames().join(' / ')})` }),
      ),
    }),
    async execute(_toolCallId, params): Promise<{ content: { type: 'text'; text: string }[]; details: ToolDetails }> {
      const body = resolveHelpTopic(params.topic);
      return textResult(body);
    },
  });

  return [searchTool, queryTool, readTool, backlinksTool, tagsTool, helpTool] as const;
}

/** ツール名の固定セット (ADR-0008 / ADR-0010 に記録されたツール境界)。sorted */
export const VAULT_READ_TOOL_NAMES = ['backlinks', 'help', 'query', 'read_note', 'search', 'tags'] as const;
