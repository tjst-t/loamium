import { resolve, sep } from 'node:path'
import { normalizeVaultPath, VaultPathError } from './vault-path'

/**
 * vault ルートと相対パスから絶対パスを作る。
 * `..` の拒否に加えて、解決後のパスが本当にルート配下かを二重に検証する。
 *
 * ⚠️ **このモジュールは `node:path` に依存するので UI から import しないこと。**
 * `packages/shared` の index は両方から読まれるため、Node 専用のものはここに置く。
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
