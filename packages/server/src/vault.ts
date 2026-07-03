/**
 * vault ファイル操作。すべてのパスは shared の normalizeVaultPath を通した
 * vault 相対パスを受け取り、ここで絶対パス解決 + 封じ込め検証 (defense in depth) を行う。
 * 書き込みは常に UTF-8 / LF (VISION tech_constraints)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toLf } from '@loamium/shared';

export class VaultContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultContainmentError';
  }
}

/**
 * vault 相対パスを絶対パスに解決し、vault ルート内であることを検証する。
 * (normalizeVaultPath 済みの入力を前提とするが、二重に防御する)
 */
export function resolveVaultFile(vaultRoot: string, relPath: string): string {
  const rootAbs = path.resolve(vaultRoot);
  const abs = path.resolve(rootAbs, relPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new VaultContainmentError(`path escapes vault root: ${relPath}`);
  }
  return abs;
}

/** ノートを読む。存在しなければ null。 */
export async function readNote(vaultRoot: string, relPath: string): Promise<string | null> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
      return null;
    }
    throw err;
  }
}

/** ノートを書く (親ディレクトリ自動作成、UTF-8 / LF 固定)。 */
export async function writeNote(
  vaultRoot: string,
  relPath: string,
  content: string,
): Promise<{ created: boolean }> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  const existed = await fileExists(abs);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, toLf(content), 'utf8');
  return { created: !existed };
}

/** ノートを削除する。存在しなければ false。 */
export async function deleteNote(vaultRoot: string, relPath: string): Promise<boolean> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
