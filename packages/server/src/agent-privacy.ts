/**
 * エージェント機密領域 deny リストの読込と強制 (ADR-0014 / Sf4ee2f)。
 *
 * ADR-0014 契約:
 * - `.loamium/agent-privacy.json` に vault 相対の glob/パス deny リストを定義する
 *   (ADR-0002 様式 = .loamium 配下だが git 追跡)。
 * - マッチするノートは、エージェントの全ツール (read_note/backlinks/write 系すべて) が
 *   読み書きを拒否し、search/query/backlinks/tags がエージェントに返す結果から除外する
 *   (存在も内容も知らせない)。
 * - 強制はサーバー側。付与ケーパビリティや web 設定に関わらず適用、deny は allow に優先。
 * - 強制点は「エージェントに渡る直前の共通フィルタ」に集約する (各ツールに散らさない)。
 * - 既定は空 (何も隠さない)。
 *
 * 安全側の既定 (DESIGN_PRINCIPLES priority 2: 迷ったらファイルを守る側):
 * - ファイル不在 (ENOENT) → 空 deny (常に false)。何も隠さない。
 * - 壊れた JSON / スキーマ検証失敗 → deny-all (常に true)。設定破損で機密が露出するより
 *   読み取りを止める方を選ぶ。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  agentPrivacySchema,
  compilePrivacyMatcher,
  type QueryableNote,
  type SearchResult,
  type TagCount,
  type BacklinkSource,
} from '@loamium/shared';
import type { VaultIndex } from './noteIndex.js';

/** deny 判定クロージャを持つ privacy ハンドル。 */
export interface AgentPrivacy {
  /** relPath (vault 相対、"/" 区切り) が deny 対象なら true。 */
  isDenied: (relPath: string) => boolean;
}

/**
 * `.loamium/agent-privacy.json` を読み deny 判定クロージャを構築する。
 * agent.json と同様、セッション生成時に毎回読み直す (キャッシュしない)。
 *
 * - 不在 (ENOENT) → 空 deny (常に false)。
 * - 読込・JSON パース・スキーマ検証のいずれかに失敗 → deny-all (常に true)。
 */
export async function loadAgentPrivacy(vaultRoot: string): Promise<AgentPrivacy> {
  const configPath = path.join(vaultRoot, '.loamium', 'agent-privacy.json');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // 既定: deny リスト不在 → 何も隠さない
      return { isDenied: () => false };
    }
    // 読込エラー (権限等) → 安全側 deny-all
    return { isDenied: () => true };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // 壊れた JSON → 安全側 deny-all
    return { isDenied: () => true };
  }

  const parsed = agentPrivacySchema.safeParse(json);
  if (!parsed.success) {
    // スキーマ検証失敗 → 安全側 deny-all
    return { isDenied: () => true };
  }

  const isDenied = compilePrivacyMatcher(parsed.data.deny);
  return { isDenied };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * 共通フィルタビュー: VaultIndex の read メソッド (search/queryNotes/tags/backlinks) を
 * deny 除外した「同じ型」で返すラッパを構築する (ADR-0014: 強制点の集約)。
 *
 * このビューが返す結果には deny ノートの存在・内容・タグ・スニペットが一切漏れない。
 * UI (人間) 向けの REST 検索/クエリ経路はこのビューを通らないため従来どおり。
 *
 * VaultIndex 全体をプロキシせず、エージェントツールが使う 4 メソッドのみ絞った型で返す。
 */
export type PrivacyFilteredIndex = Pick<
  VaultIndex,
  'search' | 'queryNotes' | 'tags' | 'backlinks'
>;

export function createPrivacyFilteredIndex(
  index: VaultIndex,
  isDenied: (relPath: string) => boolean,
): PrivacyFilteredIndex {
  return {
    search(query: string, limit?: number): SearchResult[] {
      // deny ノートを除外。除外で件数が減る分、内部的に多めに引いてから絞る。
      // (limit は「エージェントに返す最大件数」の意味に保つ。)
      const want = limit ?? 50;
      // deny を除いた後に want 件確保できるよう、余裕をもって取得する。
      const raw = index.search(query, want * 2 + want);
      const filtered = raw.filter((r) => !isDenied(r.path));
      return filtered.slice(0, want);
    },

    queryNotes(): QueryableNote[] {
      return index.queryNotes().filter((n) => !isDenied(n.path));
    },

    tags(): TagCount[] {
      // deny ノート限定タグが漏れないよう、非 deny ノートの .tags から再集約する
      // (index.tags() は全ノート集約のため使えない)。
      // 集計方式は noteIndex.tags() と同一: key = lowercase、最初の表記を採用、
      // 件数降順 → タグ昇順。
      const counts = new Map<string, { tag: string; count: number }>();
      for (const note of index.queryNotes()) {
        if (isDenied(note.path)) continue;
        for (const tag of note.tags) {
          const key = tag.toLowerCase();
          const cur = counts.get(key);
          if (cur) {
            cur.count += 1;
          } else {
            counts.set(key, { tag, count: 1 });
          }
        }
      }
      return [...counts.values()].sort((a, b) =>
        a.count !== b.count ? b.count - a.count : a.tag < b.tag ? -1 : 1,
      );
    },

    backlinks(targetRel: string): BacklinkSource[] {
      // ターゲットが deny なら存在ごと隠す (空を返す)。
      if (isDenied(targetRel)) return [];
      // 参照元 source が deny のものは除外する。
      return index.backlinks(targetRel).filter((src) => !isDenied(src.source));
    },
  };
}
