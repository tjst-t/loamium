import { resolve, sep } from 'node:path'

/** vault 外を指すパス・不正なパスが与えられた */
export class VaultPathError extends Error {
  override readonly name = 'VaultPathError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * vault 相対パスを正規化する。**vault 内パスは必ずここを経由すること。**
 *
 * - NFC 正規化する (濁点の合成/分解でリンクが解決できなくなるのを防ぐ)
 * - `\` を `/` に寄せる (Windows 経由の入力)
 * - `.` を畳み、`..` は**拒否する** (vault 脱出の防止)
 * - 先頭の `/` を落とす (絶対パス指定で脱出させない)
 *
 * URL エンコードされた `..` はデコード後にここへ到達するため、
 * ルーティング層の正規化に依存せずこの層で必ず弾く。
 */
export function normalizeVaultPath(relPath: string): string {
  if (relPath.includes('\0')) throw new VaultPathError('パスに NUL が含まれています')

  const unified = relPath.normalize('NFC').replace(/\\/g, '/')
  const segments: string[] = []
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw new VaultPathError(`vault の外を指しています: ${relPath}`)
    segments.push(seg)
  }
  if (segments.length === 0) throw new VaultPathError('パスが空です')
  return segments.join('/')
}

/**
 * vault ルートと相対パスから絶対パスを作る。
 * `..` の拒否に加えて、解決後のパスが本当にルート配下かを二重に検証する。
 */
export function resolveVaultPath(root: string, relPath: string): string {
  const rel = normalizeVaultPath(relPath)
  const rootAbs = resolve(root)
  const full = resolve(rootAbs, rel)
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    throw new VaultPathError(`vault の外を指しています: ${relPath}`)
  }
  return full
}
