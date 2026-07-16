/**
 * CommandEditor 検出ユーティリティ (ADR-0024)。
 *
 * isCommandFile(path):
 *   - path が 'commands/' で始まる
 *   - かつ .yaml または .yml 拡張子を持つ
 *   → 両方を満たすとき CommandEditor を描画する。
 *
 * isCommandNote は後方互換のエイリアス(frontmatter 引数は無視)。
 * ADR-0024 以前は commands/*.md + loamium-command frontmatter が判定条件だったが、
 * ADR-0024 でコマンド定義が .yaml ファイル全体になったため、
 * 検出シグナルはパスのみ (frontmatter 不要)。
 *
 * journalDateOf(path) のパターンを踏襲した純粋関数。
 */

/** commands/*.yaml / commands/*.yml を検出する正規表現。 */
const COMMAND_FILE_RE = /\.ya?ml$/i;

/**
 * コマンド定義ファイルかどうかを判定する (ADR-0024)。
 * AC-ADR-0024: path が 'commands/' または 'system/commands/' で始まり、
 * かつ .yaml / .yml 拡張子を持つ場合に true。frontmatter の有無は問わない。
 *
 * Sa10026-2-2 でコマンド正本が system/commands/ へ昇格するため、
 * トップレベル 'commands/'(レガシー) に加えて 'system/commands/' も
 * CommandEditor で扱う (保存=昇格後も CommandEditor で開けるようにする)。
 */
export function isCommandFile(path: string): boolean {
  const inCommandsDir = path.startsWith('commands/') || path.startsWith('system/commands/');
  if (!inCommandsDir) return false;
  return COMMAND_FILE_RE.test(path);
}

/**
 * system/ 配下の設定ファイル (yaml / md) かを判定する (Sa10026-9 #4)。
 * true のとき、notes API (.md 強制) ではなく
 * GET/PUT /api/system-files/{path}/source 経由で読み書きする。
 * commands/*.yaml (トップレベル・レガシー) は CommandEditor が扱うため対象外。
 */
export function isSystemSourceFile(path: string): boolean {
  return path === 'system' || path.startsWith('system/');
}

/**
 * @deprecated ADR-0024 以降は isCommandFile(path) を使用する。
 * 後方互換のため残す。frontmatter 引数は無視する。
 */
export function isCommandNote(
  path: string,
  _frontmatter?: Record<string, unknown> | null,
): boolean {
  return isCommandFile(path);
}
