/**
 * CommandEditor 検出ユーティリティ (ADR-0012)。
 *
 * isCommandFile(path):
 *   - path が 'commands/' で始まる
 *   - かつ .yaml または .yml 拡張子を持つ
 *   → 両方を満たすとき CommandEditor を描画する。
 *
 * isCommandNote は後方互換のエイリアス(frontmatter 引数は無視)。
 * ADR-0012 以前は commands/*.md + loamium-command frontmatter が判定条件だったが、
 * ADR-0012 でコマンド定義が .yaml ファイル全体になったため、
 * 検出シグナルはパスのみ (frontmatter 不要)。
 *
 * journalDateOf(path) のパターンを踏襲した純粋関数。
 */

/** commands/*.yaml / commands/*.yml を検出する正規表現。 */
const COMMAND_FILE_RE = /\.ya?ml$/i;

/**
 * コマンド定義ファイルかどうかを判定する (ADR-0012)。
 * AC-ADR-0012: path が 'commands/' で始まり、かつ .yaml / .yml 拡張子を持つ場合に true。
 * frontmatter の有無は問わない。
 */
export function isCommandFile(path: string): boolean {
  if (!path.startsWith('commands/')) return false;
  return COMMAND_FILE_RE.test(path);
}

/**
 * @deprecated ADR-0012 以降は isCommandFile(path) を使用する。
 * 後方互換のため残す。frontmatter 引数は無視する。
 */
export function isCommandNote(
  path: string,
  _frontmatter?: Record<string, unknown> | null,
): boolean {
  return isCommandFile(path);
}
