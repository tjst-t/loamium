/**
 * フォルダ移動共通ヘルパー (S2e8a4c-3 / S2e8a4c-7 共用)。
 *
 * フォルダは vault に物理実体を持たないため、フォルダ配下の全ノートを
 * api.renameNote で逐次移動する。移動先ノート名衝突 (409) や vault 外
 * パス (400) はサーバーが拒否するため、エラーは呼び出し元に伝播させる。
 */
import { api, ApiError } from './api.js';

/** ノート 1 件を targetFolder に移動する。targetFolder='' はルートへ移動。 */
export async function moveNote(
  sourcePath: string,
  targetFolder: string,
): Promise<void> {
  const basename = sourcePath.split('/').at(-1) ?? sourcePath;
  const newPath = targetFolder === '' ? basename : `${targetFolder}/${basename}`;
  if (newPath === sourcePath) return; // 同フォルダ = no-op
  await api.renameNote(sourcePath, newPath);
}

/**
 * フォルダ配下の全ノートを targetFolder の同名サブフォルダ以下へ移動する。
 *
 * 例: sourceFolder='a/b' → targetFolder='c' の場合
 *   'a/b/note.md' → 'c/b/note.md'
 *
 * @param notes vault の全ノート一覧
 * @param sourceFolder 移動元フォルダパス (末尾スラッシュなし)
 * @param targetFolder 移動先の親フォルダ ('' = ルート)
 */
export async function moveFolder(
  notes: { path: string }[],
  sourceFolder: string,
  targetFolder: string,
): Promise<void> {
  // sourceFolder 直下のノート (再帰含む)
  const prefix = `${sourceFolder}/`;
  const targets = notes.filter((n) => n.path === sourceFolder || n.path.startsWith(prefix));

  // sourceFolder の basename
  const folderBasename = sourceFolder.split('/').at(-1) ?? sourceFolder;
  const newParent = targetFolder === '' ? folderBasename : `${targetFolder}/${folderBasename}`;

  for (const note of targets) {
    const rel = note.path.startsWith(prefix) ? note.path.slice(prefix.length) : note.path;
    const newPath = `${newParent}/${rel}`;
    if (newPath === note.path) continue;
    await api.renameNote(note.path, newPath);
  }
}

export { ApiError };
