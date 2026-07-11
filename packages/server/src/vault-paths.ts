/**
 * vault パス操作のサーバー共通ユーティリティ。
 * routes/templates.ts と routes/commands.ts で共有する。
 */
import { noteMtime } from './vault.js';

/**
 * vault 相対パスに連番 (_2, _3, ...) を付けて最初の空きパスを返す。
 * templates.ts / commands.ts の両ルートで同一実装を共有する (D-1)。
 */
export async function firstFreePath(vaultRoot: string, rel: string): Promise<string> {
  if ((await noteMtime(vaultRoot, rel)) === null) return rel;
  const dot = rel.toLowerCase().lastIndexOf('.md');
  const stem = dot === -1 ? rel : rel.slice(0, dot);
  const ext = dot === -1 ? '' : rel.slice(dot);
  for (let n = 2; n <= 9999; n++) {
    const candidate = `${stem}_${String(n)}${ext}`;
    if ((await noteMtime(vaultRoot, candidate)) === null) return candidate;
  }
  throw new Error(`no free path for ${rel} (suffix _2.._9999 all taken)`);
}
