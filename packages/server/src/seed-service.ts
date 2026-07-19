/**
 * SeedService — サンプルファイルを vault へ投入するサービス層 (S7e2d5c-1)。
 *
 * コピー元: packages/server/src/samples/**
 * 投入先マッピング:
 *   commands/*.yaml          → system/commands/
 *   templates/*.md           → templates/
 *   smart-folders/*.yaml     → system/smart-folders/
 *   <その他> (samples/**)   → samples/
 *
 * - copyIfAbsent (force=false): 既存ファイルはスキップ (上書きしない)。
 * - force=true: 既存ファイルも上書き。
 * - 書き込みは vault.ts の writeNote / writeVaultFile 経由 (containment 検証済み、ADR-0016)。
 * - UTF-8 / LF 固定 (writeNote が toLf を適用)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNote } from './vault.js';

/** SeedService 実行結果 */
export interface SeedResult {
  /** 投入されたファイル数 */
  seeded: number;
  /** スキップされたファイル数 (既存 + force=false の場合) */
  skipped: number;
}

/** samples/ のソースルートを求める (ESM __dirname 相当)。 */
function samplesRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), 'samples');
}

/**
 * vault 相対パスへのマッピングを解決する。
 *
 * @param samplesRelPath samples/ 内の相対パス (例: "commands/todo-add.yaml")
 * @returns vault 相対パス (例: "system/commands/todo-add.yaml")
 */
export function mapSeedPath(samplesRelPath: string): string {
  // commands/*.yaml → system/commands/<name>.yaml
  if (samplesRelPath.startsWith('commands/') && samplesRelPath.endsWith('.yaml')) {
    const name = samplesRelPath.slice('commands/'.length);
    return `system/commands/${name}`;
  }
  // smart-folders/*.yaml → system/smart-folders/<name>.yaml
  if (samplesRelPath.startsWith('smart-folders/') && samplesRelPath.endsWith('.yaml')) {
    const name = samplesRelPath.slice('smart-folders/'.length);
    return `system/smart-folders/${name}`;
  }
  // templates/*.md → templates/<name>.md
  if (samplesRelPath.startsWith('templates/') && samplesRelPath.endsWith('.md')) {
    const name = samplesRelPath.slice('templates/'.length);
    return `templates/${name}`;
  }
  // その他すべては samples/ 配下へ (index.md も含む)
  return `samples/${samplesRelPath}`;
}

/**
 * samples/ 内の全ファイルを再帰的に列挙し、samples/ からの相対パスを返す。
 * ドット始まりのセグメントは除外 (hidden protection)。
 */
async function listSamplesFiles(srcRoot: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  await walk(srcRoot, '');
  out.sort();
  return out;
}

/**
 * vault 相対パスに対応するファイルが既存かチェックする。
 */
async function vaultFileExists(vaultRoot: string, vaultRel: string): Promise<boolean> {
  const abs = path.resolve(vaultRoot, vaultRel);
  try {
    const st = await fs.stat(abs);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * サンプルファイルを vault へ投入する。
 *
 * @param vaultRoot vault のルートディレクトリ絶対パス
 * @param force     true なら既存ファイルを上書き、false なら既存はスキップ
 * @param srcRoot   コピー元 (省略時は packages/server/src/samples/)
 * @returns { seeded, skipped }
 */
export async function seed(
  vaultRoot: string,
  force = false,
  srcRoot?: string,
): Promise<SeedResult> {
  const src = srcRoot ?? samplesRoot();
  const files = await listSamplesFiles(src);

  let seeded = 0;
  let skipped = 0;

  for (const samplesRel of files) {
    const vaultRel = mapSeedPath(samplesRel);
    const srcAbs = path.join(src, samplesRel);

    if (!force) {
      const exists = await vaultFileExists(vaultRoot, vaultRel);
      if (exists) {
        skipped++;
        continue;
      }
    }

    // テキストファイル (.md / .yaml / .yml / .json / .txt) は writeNote 経由 (toLf 適用)。
    // バイナリ (.png 等) は fs.copyFile で無加工コピー。
    const ext = path.extname(samplesRel).toLowerCase();
    const isText = ['.md', '.yaml', '.yml', '.json', '.txt', '.html', '.css', '.js', '.ts'].includes(ext);

    if (isText) {
      const content = await fs.readFile(srcAbs, 'utf8');
      await writeNote(vaultRoot, vaultRel, content);
    } else {
      // バイナリ: 親ディレクトリを作成してから copyFile
      const dstAbs = path.resolve(vaultRoot, vaultRel);
      await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      await fs.copyFile(srcAbs, dstAbs);
    }
    seeded++;
  }

  return { seeded, skipped };
}
