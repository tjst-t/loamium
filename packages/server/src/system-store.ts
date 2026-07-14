/**
 * system/ フォルダの per-file 定義を読み書きするストア層 (Sa10026-1-2)。
 *
 * ADR-0010 (2026-07-14 amendment) に準拠:
 *   - system/smart-folders/*.yaml — 純 YAML (query: DQL 文字列)
 *   - system/commands/*.yaml      — 純 YAML (コマンドメタ + steps 等)
 *   - system/templates/*.md       — .md + YAML frontmatter
 *
 * 設計方針:
 *   - 寛容 read: zod 失敗 / YAML 壊れ → 既定/空フォールバック (console.error のみ)。
 *     アプリは決して 500 にならない (priority 6: ファイルが正)。
 *   - 書き込みは UTF-8 / LF 固定 (VISION tech_constraints)。
 *   - [AC-Sa10026-1-2] order → ファイル名の安定ソートを適用して結果を返す。
 *   - [AC-Sa10026-1-3] vault 外脱出を resolveVaultFile + normalizeSystemPath で二重防御。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toLf } from '@loamium/shared';
import {
  SYSTEM_SMART_FOLDERS_DIR,
  SYSTEM_COMMANDS_DIR,
  SYSTEM_TEMPLATES_DIR,
  buildSystemSmartFolderDef,
  buildSystemCommandDef,
  buildSystemTemplateDef,
  sortSystemDefs,
  normalizeSystemPath,
  VaultPathError,
  type SystemSmartFolderDef,
  type SystemCommandDef,
  type SystemTemplateDef,
} from '@loamium/shared';
import { resolveVaultFile } from './vault.js';

// ---- 共通: ディレクトリ走査 ----

/**
 * vault 内の dirRel (vault 相対パス) を走査し、拡張子フィルタを満たすファイル一覧を返す。
 * ドット始まりのセグメントは除外 (hidden protection)。
 * ディレクトリが存在しない場合は空配列を返す (寛容)。
 */
async function listDirFiles(
  vaultRoot: string,
  dirRel: string,
  extFilter: (name: string) => boolean,
): Promise<string[]> {
  let dirAbs: string;
  try {
    dirAbs = resolveVaultFile(vaultRoot, dirRel);
  } catch {
    return []; // containment エラーは無視 (通常到達しない)
  }

  const out: string[] = [];

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // ディレクトリが存在しない場合等
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // hidden protection
      const entryAbs = path.join(absDir, entry.name);
      const entryRel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(entryAbs, entryRel);
      } else if (entry.isFile() && extFilter(entry.name)) {
        out.push(entryRel.normalize('NFC'));
      }
    }
  };

  await walk(dirAbs, dirRel);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** YAML ファイル拡張子フィルタ */
function isYamlFile(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/** Markdown ファイル拡張子フィルタ */
function isMdFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

// ---- ファイル読み取り (寛容) ----

async function readFileText(vaultRoot: string, relPath: string): Promise<string | null> {
  let abs: string;
  try {
    abs = resolveVaultFile(vaultRoot, relPath);
  } catch {
    return null;
  }
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.error(`[loamium/system-store] failed to read ${relPath}: ${String(err)}`);
    }
    return null;
  }
}

// ---- ファイル書き込み ----

async function writeFileText(
  vaultRoot: string,
  relPath: string,
  content: string,
): Promise<{ created: boolean; mtime: number }> {
  const abs = resolveVaultFile(vaultRoot, relPath);
  let existed = false;
  try {
    const st = await fs.stat(abs);
    existed = st.isFile();
  } catch {
    existed = false;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, toLf(content), 'utf8');
  const st = await fs.stat(abs);
  return { created: !existed, mtime: Math.trunc(st.mtimeMs) };
}

// ---- mtime 取得 ----

async function fileMtime(vaultRoot: string, relPath: string): Promise<number | null> {
  let abs: string;
  try {
    abs = resolveVaultFile(vaultRoot, relPath);
  } catch {
    return null;
  }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return Math.trunc(st.mtimeMs);
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.error(`[loamium/system-store] failed to stat ${relPath}: ${String(err)}`);
    }
    return null;
  }
}

// ---- SmartFolder (system/smart-folders/*.yaml) ----

/**
 * system/smart-folders/ 配下の全 .yaml ファイルを読み込み、
 * [AC-Sa10026-1-2] order → ファイル名の安定ソートで返す。
 * 読み込みエラー / スキーマ不合格のファイルは console.error してスキップ。
 * [AC-Sa10026-1-1] [AC-Sa10026-1-3]
 */
export async function listSystemSmartFolders(
  vaultRoot: string,
): Promise<SystemSmartFolderDef[]> {
  const files = await listDirFiles(vaultRoot, SYSTEM_SMART_FOLDERS_DIR, isYamlFile);
  const defs: SystemSmartFolderDef[] = [];

  for (const relPath of files) {
    const text = await readFileText(vaultRoot, relPath);
    if (text === null) continue;
    const def = buildSystemSmartFolderDef(relPath, text);
    if (def === null) {
      // スキーマ不合格 (query フィールドなし等) — 寛容 read: スキップ + ログ
      console.error(
        `[loamium/system-store] smart-folder definition invalid (skipped): ${relPath}`,
      );
      continue;
    }
    defs.push(def);
  }

  return sortSystemDefs(defs);
}

/**
 * system/smart-folders/{id}.yaml の内容を読み込んで返す。
 * ファイルが存在しない / 不正 → null。
 * [AC-Sa10026-1-1] [AC-Sa10026-1-3]
 */
export async function readSystemSmartFolder(
  vaultRoot: string,
  id: string,
): Promise<SystemSmartFolderDef | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_SMART_FOLDERS_DIR}/${id}.yaml`);
  } catch (err) {
    if (err instanceof VaultPathError) return null;
    throw err;
  }

  const text = await readFileText(vaultRoot, relPath);
  if (text === null) return null;
  return buildSystemSmartFolderDef(relPath, text);
}

/**
 * system/smart-folders/{id}.yaml に純 YAML テキストを書き込む。
 * パス検証は normalizeSystemPath 経由 (AC-Sa10026-1-3)。
 * UTF-8 / LF 固定。
 */
export async function writeSystemSmartFolder(
  vaultRoot: string,
  id: string,
  yamlContent: string,
): Promise<{ created: boolean; mtime: number }> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_SMART_FOLDERS_DIR}/${id}.yaml`);
  } catch (err) {
    if (err instanceof VaultPathError) throw err;
    throw err;
  }
  return writeFileText(vaultRoot, relPath, yamlContent);
}

/**
 * system/smart-folders/{id}.yaml を削除する。
 * ファイルが存在しなければ false を返す (エラーにならない)。
 */
export async function deleteSystemSmartFolder(
  vaultRoot: string,
  id: string,
): Promise<boolean> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_SMART_FOLDERS_DIR}/${id}.yaml`);
  } catch (err) {
    if (err instanceof VaultPathError) return false;
    throw err;
  }
  let abs: string;
  try {
    abs = resolveVaultFile(vaultRoot, relPath);
  } catch {
    return false;
  }
  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) return false;
    throw err;
  }
}

/**
 * system/smart-folders/{id}.yaml の mtime を返す。存在しなければ null。
 */
export async function systemSmartFolderMtime(
  vaultRoot: string,
  id: string,
): Promise<number | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_SMART_FOLDERS_DIR}/${id}.yaml`);
  } catch {
    return null;
  }
  return fileMtime(vaultRoot, relPath);
}

// ---- Command (system/commands/*.yaml) ----

/**
 * system/commands/ 配下の全 .yaml ファイルを読み込み、
 * [AC-Sa10026-1-2] order → ファイル名の安定ソートでメタ情報を返す。
 * 読み込みエラーのファイルはスキップ (buildSystemCommandDef は常に値を返すため常時フォールバック)。
 * [AC-Sa10026-1-1] [AC-Sa10026-1-3]
 */
export async function listSystemCommands(
  vaultRoot: string,
): Promise<SystemCommandDef[]> {
  const files = await listDirFiles(vaultRoot, SYSTEM_COMMANDS_DIR, isYamlFile);
  const defs: SystemCommandDef[] = [];

  for (const relPath of files) {
    const text = await readFileText(vaultRoot, relPath);
    if (text === null) continue;
    defs.push(buildSystemCommandDef(relPath, text));
  }

  return sortSystemDefs(defs);
}

/**
 * system/commands/{id}.yaml の内容を読み込んで返す。
 * ファイルが存在しない → null。
 * [AC-Sa10026-1-1] [AC-Sa10026-1-3]
 */
export async function readSystemCommandMeta(
  vaultRoot: string,
  id: string,
): Promise<SystemCommandDef | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${id}.yaml`);
  } catch (err) {
    if (err instanceof VaultPathError) return null;
    throw err;
  }

  const text = await readFileText(vaultRoot, relPath);
  if (text === null) return null;
  return buildSystemCommandDef(relPath, text);
}

/**
 * system/commands/{id}.yaml に純 YAML テキストを書き込む。
 * パス検証は normalizeSystemPath 経由 (AC-Sa10026-1-3)。
 * UTF-8 / LF 固定。
 */
export async function writeSystemCommand(
  vaultRoot: string,
  id: string,
  yamlContent: string,
): Promise<{ created: boolean; mtime: number }> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${id}.yaml`);
  } catch (err) {
    if (err instanceof VaultPathError) throw err;
    throw err;
  }
  return writeFileText(vaultRoot, relPath, yamlContent);
}

/**
 * system/commands/{id}.yaml の生テキストを読む (source 読み書き用)。
 * ファイルが存在しなければ null。
 */
export async function readSystemCommandRaw(
  vaultRoot: string,
  id: string,
): Promise<{ content: string; mtime: number } | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${id}.yaml`);
  } catch {
    return null;
  }
  const text = await readFileText(vaultRoot, relPath);
  if (text === null) return null;
  const mtime = (await fileMtime(vaultRoot, relPath)) ?? Date.now();
  return { content: text, mtime };
}

/**
 * system/commands/{id}.yaml を削除する。
 * ファイルが存在しなければ false。
 */
export async function deleteSystemCommand(
  vaultRoot: string,
  id: string,
): Promise<boolean> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${id}.yaml`);
  } catch {
    return false;
  }
  let abs: string;
  try {
    abs = resolveVaultFile(vaultRoot, relPath);
  } catch {
    return false;
  }
  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) return false;
    throw err;
  }
}

/**
 * system/commands/{id}.yaml の mtime を返す。存在しなければ null。
 */
export async function systemCommandMtime(
  vaultRoot: string,
  id: string,
): Promise<number | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_COMMANDS_DIR}/${id}.yaml`);
  } catch {
    return null;
  }
  return fileMtime(vaultRoot, relPath);
}

// ---- Template (system/templates/*.md) ----

/**
 * system/templates/ 配下の全 .md ファイルを読み込み、
 * [AC-Sa10026-1-2] order → ファイル名の安定ソートでメタ情報を返す。
 * 読み込みエラーのファイルはスキップ。
 * [AC-Sa10026-1-1] [AC-Sa10026-1-3]
 */
export async function listSystemTemplates(
  vaultRoot: string,
): Promise<SystemTemplateDef[]> {
  const files = await listDirFiles(vaultRoot, SYSTEM_TEMPLATES_DIR, isMdFile);
  const defs: SystemTemplateDef[] = [];

  for (const relPath of files) {
    const text = await readFileText(vaultRoot, relPath);
    if (text === null) continue;
    defs.push(buildSystemTemplateDef(relPath, text));
  }

  return sortSystemDefs(defs);
}

/**
 * system/templates/{id}.md の内容を読み込んで返す。
 * ファイルが存在しない → null。
 * [AC-Sa10026-1-1] [AC-Sa10026-1-3]
 */
export async function readSystemTemplate(
  vaultRoot: string,
  id: string,
): Promise<{ def: SystemTemplateDef; content: string } | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_TEMPLATES_DIR}/${id}.md`);
  } catch (err) {
    if (err instanceof VaultPathError) return null;
    throw err;
  }

  const text = await readFileText(vaultRoot, relPath);
  if (text === null) return null;
  const def = buildSystemTemplateDef(relPath, text);
  return { def, content: text };
}

/**
 * system/templates/{id}.md に .md テキストを書き込む。
 * パス検証は normalizeSystemPath 経由 (AC-Sa10026-1-3)。
 * UTF-8 / LF 固定 (toLf 経由)。
 */
export async function writeSystemTemplate(
  vaultRoot: string,
  id: string,
  mdContent: string,
): Promise<{ created: boolean; mtime: number }> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_TEMPLATES_DIR}/${id}.md`);
  } catch (err) {
    if (err instanceof VaultPathError) throw err;
    throw err;
  }
  return writeFileText(vaultRoot, relPath, mdContent);
}

/**
 * system/templates/{id}.md を削除する。
 * ファイルが存在しなければ false。
 */
export async function deleteSystemTemplate(
  vaultRoot: string,
  id: string,
): Promise<boolean> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_TEMPLATES_DIR}/${id}.md`);
  } catch {
    return false;
  }
  let abs: string;
  try {
    abs = resolveVaultFile(vaultRoot, relPath);
  } catch {
    return false;
  }
  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) return false;
    throw err;
  }
}

/**
 * system/templates/{id}.md の mtime を返す。存在しなければ null。
 */
export async function systemTemplateMtime(
  vaultRoot: string,
  id: string,
): Promise<number | null> {
  let relPath: string;
  try {
    relPath = normalizeSystemPath(`${SYSTEM_TEMPLATES_DIR}/${id}.md`);
  } catch {
    return null;
  }
  return fileMtime(vaultRoot, relPath);
}
