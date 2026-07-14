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

/**
 * ノートの mtime (ms epoch、整数へ切り捨て) を返す。存在しなければ null。
 * 楽観的競合検出 (PUT baseMtime) と GET レスポンスの mtime に使う。
 */
export async function noteMtime(vaultRoot: string, relPath: string): Promise<number | null> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return Math.trunc(st.mtimeMs);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** ノートを書く (親ディレクトリ自動作成、UTF-8 / LF 固定)。書き込み後の mtime を返す。 */
export async function writeNote(
  vaultRoot: string,
  relPath: string,
  content: string,
): Promise<{ created: boolean; mtime: number }> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  const existed = await fileExists(abs);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, toLf(content), 'utf8');
  const st = await fs.stat(abs);
  return { created: !existed, mtime: Math.trunc(st.mtimeMs) };
}

/**
 * vault 内の任意ファイルをバイト列で読む (S9e5ca4-2: files 配信用)。
 * 存在しない / ディレクトリなら null。読み取り専用 — 書き込み系は提供しない。
 */
export async function readVaultFile(vaultRoot: string, relPath: string): Promise<Buffer | null> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return await fs.readFile(abs);
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'EISDIR')) {
      return null;
    }
    throw err;
  }
}

/**
 * vault 内の全ノート (.md) の相対パス一覧を返す (NFC 正規化・"/" 区切り・パス昇順)。
 * ドット始まりのセグメント (.loamium / .git / .obsidian) は除外。
 * リネーム追従の「ファイルが正」走査に使う (インデックスの鮮度に依存しない)。
 */
export async function listNoteFiles(vaultRoot: string): Promise<string[]> {
  const root = path.resolve(vaultRoot);
  const out: string[] = [];
  const walk = async (dirAbs: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // 消えたディレクトリ等は無視 (ファイルが正)
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(path.relative(root, abs).split(path.sep).join('/').normalize('NFC'));
      }
    }
  };
  await walk(root);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

export interface VaultFileStat {
  size: number;
  mtime: number;
}

/** 任意ファイルの stat (size + mtime)。存在しない / ディレクトリなら null。 */
export async function statVaultFile(
  vaultRoot: string,
  relPath: string,
): Promise<VaultFileStat | null> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return { size: st.size, mtime: Math.trunc(st.mtimeMs) };
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/** パスがディレクトリとして存在するか。 */
export async function isVaultDirectory(vaultRoot: string, relPath: string): Promise<boolean> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * vault 内へ任意ファイルをバイト列で書く (Sf53ad6-1: アップロード)。
 * 親ディレクトリ自動作成。バイト列は無加工で書く (改行変換もしない — 添付は正本のバイナリ)。
 */
export async function writeVaultFile(
  vaultRoot: string,
  relPath: string,
  data: Buffer,
): Promise<{ created: boolean; size: number; mtime: number }> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  const existed = await fileExists(abs);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
  const st = await fs.stat(abs);
  return { created: !existed, size: st.size, mtime: Math.trunc(st.mtimeMs) };
}

/** 任意ファイルを削除する。存在しなければ false。 */
export async function deleteVaultFile(vaultRoot: string, relPath: string): Promise<boolean> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return false; // ディレクトリは対象外 (安全側)
    await fs.unlink(abs);
    return true;
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    throw err;
  }
}

/**
 * 任意ファイルをディスク上で移動する (Sf53ad6-2: 添付リネーム)。
 * バイト列・mtime を保存する fs.rename を使う。移動先の親は自動作成。
 */
export async function moveVaultFile(
  vaultRoot: string,
  oldRel: string,
  newRel: string,
): Promise<void> {
  const oldAbs = resolveVaultFile(vaultRoot, oldRel);
  const newAbs = resolveVaultFile(vaultRoot, newRel);
  await fs.mkdir(path.dirname(newAbs), { recursive: true });
  await fs.rename(oldAbs, newAbs);
}

/**
 * vault 内の全「非 .md ファイル」(添付) の一覧を返す (パス昇順、NFC・"/" 区切り)。
 * ドット始まりのセグメント (.loamium / .git / .obsidian) は除外。
 * 添付ツリー表示・リネーム追従の候補集合に使う (ファイルが正 — priority 6)。
 */
export async function listVaultFiles(
  vaultRoot: string,
): Promise<{ path: string; size: number; mtime: number }[]> {
  const root = path.resolve(vaultRoot);
  const out: { path: string; size: number; mtime: number }[] = [];
  const walk = async (dirAbs: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // 消えたディレクトリ等は無視 (ファイルが正)
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && !entry.name.toLowerCase().endsWith('.md')) {
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          continue; // 走査中に消えたファイル
        }
        out.push({
          path: path.relative(root, abs).split(path.sep).join('/').normalize('NFC'),
          size: st.size,
          mtime: Math.trunc(st.mtimeMs),
        });
      }
    }
  };
  await walk(root);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * system/ 配下の全ファイル (yaml + md その他) を列挙する (Sa10026-9 #1)。
 * 拡張子を問わず列挙する (settings.yaml / smart-folders/*.yaml / templates/*.md /
 * commands/*.yaml を含む)。ドット始まりのセグメントは除外 (hidden protection)。
 * ディレクトリが無ければ空配列 (寛容 — ファイルが正)。パス昇順、NFC・"/" 区切り。
 */
export async function listSystemFiles(
  vaultRoot: string,
): Promise<{ path: string; size: number; mtime: number }[]> {
  const root = path.resolve(vaultRoot);
  const systemAbs = path.join(root, 'system');
  const out: { path: string; size: number; mtime: number }[] = [];
  const walk = async (dirAbs: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // system/ が無い等は無視 (寛容)
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // hidden protection
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          continue; // 走査中に消えたファイル
        }
        out.push({
          path: path.relative(root, abs).split(path.sep).join('/').normalize('NFC'),
          size: st.size,
          mtime: Math.trunc(st.mtimeMs),
        });
      }
    }
  };
  await walk(systemAbs);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
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
