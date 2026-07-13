/**
 * CommandEditor 検出ユーティリティ (S9e64e7-1)。
 *
 * isCommandNote(path, frontmatter):
 *   - path が 'commands/' で始まる
 *   - frontmatter に 'loamium-command' キーが存在する
 *   → 両方を満たすとき CommandEditor を描画する。
 *
 * journalDateOf(path) のパターンを踏襲した純粋関数。
 */

/**
 * コマンドノートかどうかを判定する。
 * AC-S9e64e7-1-1: path が 'commands/' で始まり、かつ frontmatter に 'loamium-command' キーがある場合のみ true。
 */
export function isCommandNote(
  path: string,
  frontmatter: Record<string, unknown> | null,
): boolean {
  if (!path.startsWith('commands/')) return false;
  if (frontmatter === null) return false;
  return 'loamium-command' in frontmatter;
}
