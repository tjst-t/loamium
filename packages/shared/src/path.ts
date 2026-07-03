/**
 * vault 相対パスの正規化ユーティリティ。
 *
 * 不変条件 (DESIGN_PRINCIPLES priority 2: データ安全性):
 * - 返り値は常に vault ルートからの相対パス (`/` 区切り、先頭 `/` なし)
 * - `..` / `.` / 空セグメント / 先頭ドットのセグメント (.loamium, .git 等) は拒否
 * - NFC 正規化済み
 * - 常に `.md` で終わる (notes API は Markdown ファイルのみを扱う)
 */

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/**
 * ノートパスを正規化する。無効なパスは VaultPathError を投げる。
 *
 * @param input vault 相対のノートパス (例: "projects/loamium", "日記/メモ.md")
 * @returns 正規化済み相対パス (例: "projects/loamium.md")
 */
export function normalizeVaultPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new VaultPathError('path is empty');
  }
  if (input.includes('\0')) {
    throw new VaultPathError('path contains a null byte');
  }
  if (input.includes('\\')) {
    throw new VaultPathError('backslash is not allowed in vault paths (use "/")');
  }
  // NFC 正規化 (macOS の NFD ファイル名や IME 入力の揺れを吸収)
  const nfc = input.normalize('NFC');
  if (nfc.startsWith('/')) {
    throw new VaultPathError('absolute paths are not allowed');
  }
  if (/^[a-zA-Z]:/.test(nfc)) {
    throw new VaultPathError('drive-letter paths are not allowed');
  }

  const rawSegments = nfc.split('/');
  const segments: string[] = [];
  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (trimmed === '') {
      throw new VaultPathError('path contains an empty segment');
    }
    if (trimmed === '.' || trimmed === '..') {
      throw new VaultPathError('path traversal ("." / "..") is not allowed');
    }
    if (trimmed.startsWith('.')) {
      throw new VaultPathError(
        `hidden segments are not allowed: "${trimmed}" (protects .loamium / .git / .obsidian)`,
      );
    }
    segments.push(trimmed);
  }

  let joined = segments.join('/');
  if (!joined.toLowerCase().endsWith('.md')) {
    joined += '.md';
  }
  return joined;
}

/**
 * 正規化を試み、成否を boolean で返す軽量版。
 */
export function isValidVaultPath(input: string): boolean {
  try {
    normalizeVaultPath(input);
    return true;
  } catch {
    return false;
  }
}
