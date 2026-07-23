/**
 * 動的選択肢解決ヘルパ (ADR-0031 / S1bd397)。
 *
 * pure 関数 — IO なし。DQL エンジン (parseQuery/executeQuery) を直接再利用する (ADR-0001)。
 * サーバー側は packages/server/src/options-query-resolver.ts で VaultIndex を橋渡しする。
 *
 * エクスポートする関数:
 *   - resolveOptionsQuery    : DQL LIST を実行して候補 (title=value=label) を返す
 *   - validateOptionsDependencies : optionsQuery 間の依存宣言順を検証 (前方参照・循環禁止)
 */
import { parseQuery, executeQuery, DqlParseError, type QueryableNote } from './dql.js';
import { resolveTemplate } from './template.js';

// ---- 型 -----------------------------------------------------------------------

export interface OptionsCandidate {
  value: string;
  label: string;
}

export interface ResolveOptionsQueryResult {
  candidates: OptionsCandidate[];
  /** topN で打ち切られた場合 true (silent な切り捨てをしない) */
  truncated: boolean;
}

export interface ValidateDependenciesResult {
  valid: boolean;
  /** valid:false のときのエラーメッセージ。 */
  error?: string;
}

// ---- resolveOptionsQuery -------------------------------------------------------

/**
 * DQL LIST クエリを実行して候補一覧を返す。
 *
 * - resolvedVars があれば `{{変数名}}` を resolveTemplate で差し込んでから DQL を実行 (依存クエリ)。
 * - v1: LIST のみ対象。候補はノートタイトルを value=label とする (ADR-0031 D2)。
 * - topN: 既定 50。超過で truncated:true + 先頭 topN のみ返す (ADR-0031 D3)。
 * - 0 件は candidates:[] / truncated:false でエラーにしない (ADR-0031 D7)。
 * - LIST 以外の DQL (TABLE/TASK) を渡した場合は candidates:[] / truncated:false を返す
 *   (呼び出し元サーバー層が 400 list_only を返す。pure helper はエラーを投げない)。
 * - DQL 構文エラーは DqlParseError を再スローする (呼び出し元が 400 query_syntax を返す)。
 *
 * @param dql         - DQL クエリ文字列
 * @param notes       - 対象ノート一覧
 * @param topN        - 取得件数上限 (既定 50)
 * @param resolvedVars - 解決済み上流変数 (依存クエリ用)
 */
export function resolveOptionsQuery(
  dql: string,
  notes: readonly QueryableNote[],
  topN?: number,
  resolvedVars?: Record<string, string>,
): ResolveOptionsQueryResult {
  const limit = topN ?? 50;

  // 依存クエリ: resolvedVars があれば {{変数名}} を展開してから実行
  const effectiveDql =
    resolvedVars !== undefined && Object.keys(resolvedVars).length > 0
      ? resolveTemplate(dql, { vars: resolvedVars }).text
      : dql;

  // DQL パース (DqlParseError は呼び出し元へ再スロー)
  const ast = parseQuery(effectiveDql);

  // v1: LIST のみ。TABLE/TASK は空候補を返す
  if (ast.type !== 'list') {
    return { candidates: [], truncated: false };
  }

  // DQL 実行
  const result = executeQuery(ast, notes);
  if (result.type !== 'list') {
    // 型安全: parseQuery で type:'list' を確認済みだが念のため
    return { candidates: [], truncated: false };
  }

  const rows = result.results;
  const total = rows.length;
  const sliced = total > limit ? rows.slice(0, limit) : rows;
  const truncated = total > limit;

  /**
   * v1: 候補の value/label を決定する。
   * - 通常ファイル: title (= ファイル名の stem)
   * - `index.md` (index ファイル): 親フォルダ名を使う (より意味のある名前)。
   *   例: projects/loamium/index.md → 'loamium' / projects/webapp/index.md → 'webapp'
   */
  function candidateLabel(row: { path: string; title: string }): string {
    if (row.title.toLowerCase() === 'index') {
      // パスから親フォルダ名を取り出す
      const parts = row.path.split('/');
      // "projects/loamium/index.md" → parts = ['projects', 'loamium', 'index.md']
      // 末尾から2番目が親フォルダ名
      const parentPart = parts.length >= 2 ? parts[parts.length - 2] : undefined;
      if (parentPart !== undefined && parentPart !== '') {
        return parentPart;
      }
    }
    return row.title;
  }

  const candidates: OptionsCandidate[] = sliced.map((row) => {
    const label = candidateLabel(row);
    return { value: label, label };
  });

  return { candidates, truncated };
}

// ---- validateOptionsDependencies -----------------------------------------------

/**
 * {{変数名}} 参照を DQL 文字列から抽出する (簡易実装)。
 * テンプレートの TOKEN_RE と同じ `{{...}}` をマッチし、
 * date:/now: プリセットは除外する。
 */
function extractVarRefs(dql: string): Set<string> {
  const refs = new Set<string>();
  const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
  for (const m of dql.matchAll(re)) {
    const inner = (m[1] ?? '').trim();
    if (inner === '') continue;
    // プリセット (date:/now:) は変数参照でない
    const colon = inner.indexOf(':');
    if (colon !== -1) {
      const kind = inner.slice(0, colon).trim();
      if (kind === 'date' || kind === 'now') continue;
    }
    // パイプ付きフォールバック {{var|fallback}} → var 部分のみ
    const pipeIdx = inner.indexOf('|');
    const varName = pipeIdx !== -1 ? inner.slice(0, pipeIdx).trim() : inner;
    if (varName !== '') refs.add(varName);
  }
  return refs;
}

/**
 * optionsQuery 間の宣言順依存を検証する。
 *
 * 規則 (ADR-0031 D8):
 *   - optionsQuery 内の {{変数名}} は宣言順で既に出現した変数のみ参照可。
 *   - 自己参照・後方参照 (まだ宣言されていない変数への参照) → 'valid:false 前方参照'。
 *   - A→B→A のような循環 → 'valid:false 循環'。
 *
 * optionsQuery を持たない変数は依存グラフの対象外 (通過)。
 *
 * @param vars - {name, optionsQuery?} の配列 (宣言順)
 */
export function validateOptionsDependencies(
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  vars: Array<{ name: string; optionsQuery?: string | undefined }>,
): ValidateDependenciesResult {
  // 宣言順で既に確定した変数名セット
  const declared = new Set<string>();

  for (const v of vars) {
    const { name, optionsQuery } = v;

    if (optionsQuery !== undefined) {
      const refs = extractVarRefs(optionsQuery);

      for (const ref of refs) {
        // 自己参照
        if (ref === name) {
          return {
            valid: false,
            error: `変数 '${name}' の optionsQuery が自己参照しています (循環)`,
          };
        }
        // 後方参照: まだ宣言されていない変数を参照
        if (!declared.has(ref)) {
          // 後続の変数名リストに存在するか確認して適切なメッセージを選ぶ
          const isFutureVar = vars.some((vv) => vv.name === ref);
          if (isFutureVar) {
            return {
              valid: false,
              error: `変数 '${name}' の optionsQuery が宣言前の変数 '${ref}' を参照しています (前方参照)`,
            };
          }
          // 存在しない変数への参照は依存検証上の問題ではない (DQL 実行時に空展開になるだけ)
          // → valid と見なす (宣言順チェックのみ行う)
        }
      }

      // A→B→A 循環を検出: 宣言済み変数の optionsQuery が現在の変数 name を参照していないか確認
      // ただし、上のループで自己参照と前方参照は既に検出しているため、
      // ここでは A→B→A 型を検出: B の optionsQuery が A を参照し、
      // かつ A の optionsQuery が B を参照するケース
      for (const ref of refs) {
        if (declared.has(ref)) {
          // ref (= 上流変数) の optionsQuery が現在の変数 name を参照しているか
          const upstream = vars.find((vv) => vv.name === ref);
          if (upstream?.optionsQuery !== undefined) {
            const upstreamRefs = extractVarRefs(upstream.optionsQuery);
            if (upstreamRefs.has(name)) {
              return {
                valid: false,
                error: `変数 '${name}' と '${ref}' の間に循環依存があります (循環)`,
              };
            }
          }
        }
      }
    }

    declared.add(name);
  }

  return { valid: true };
}
