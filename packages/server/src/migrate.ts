/**
 * 設定系3系統の一括移行ランナー (Sa10026-2-1)。
 *
 * 移行対象:
 *   1. スマートフォルダ: .loamium/smart-folders.json → system/smart-folders/*.yaml
 *   2. テンプレート    : templates/*.md               → system/templates/*.md
 *   3. コマンド        : commands/*.yaml               → system/commands/*.yaml
 *
 * 設計方針:
 *   - 冪等: 移行済みマーカー (.loamium/migrate-Sa10026-2.done) があれば全系統スキップ。
 *     個別系統も dest に既に存在すればスキップ (部分移行済みも安全)。
 *   - 寛容 read: 旧形式が壊れていても残りを移行してエラーにしない。
 *   - 監査ログ: 書き込みごとに .loamium/audit.log へ記録。
 *   - 旧ファイルは削除しない (後方互換フォールバック + ユーザー手動削除に委ねる)。
 *     ただし移行後は正本から外れる (routes は system/ を優先)。
 *
 * [AC-Sa10026-2-1] 起動時に runMigration を呼ぶ。
 * [AC-Sa10026-2-3] 冪等・部分移行済み・二重実行に安全。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { toLf, smartViewConfigSchema } from '@loamium/shared';
import {
  SYSTEM_SMART_FOLDERS_DIR,
  SYSTEM_COMMANDS_DIR,
  SYSTEM_TEMPLATES_DIR,
} from '@loamium/shared';
import { writeAuditEntry } from './audit.js';
import type { ServerConfig } from './config.js';

/** 移行完了マーカーファイルのパス (vault 相対)。 */
const MARKER_REL = '.loamium/migrate-Sa10026-2.done';

// ---- ユーティリティ ----

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(absPath);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(absPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(absPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function writeUtf8Lf(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, toLf(content), 'utf8');
}

// ---- 1. スマートフォルダ移行 ----

/**
 * .loamium/smart-folders.json を読み、各 item を
 * system/smart-folders/{id}.yaml へ書き出す。
 * query item のみ移行対象 (pin は DQL クエリを持たないためスキップ)。
 * 変換:
 *   item.name  → title:
 *   item.icon  → icon:
 *   item.dql   → query:
 *   (order は記録しない — 元の並び順は items 配列のインデックス)
 *
 * [AC-Sa10026-2-1]
 */
async function migrateSmartFolders(
  vaultRoot: string,
  config: ServerConfig,
  results: string[],
): Promise<void> {
  const oldJsonAbs = path.join(vaultRoot, '.loamium', 'smart-folders.json');
  if (!(await fileExists(oldJsonAbs))) {
    results.push('smart-folders: no .loamium/smart-folders.json found, skip');
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(oldJsonAbs, 'utf8'));
  } catch (err) {
    results.push(`smart-folders: failed to parse .loamium/smart-folders.json: ${String(err)}, skip`);
    console.error(`[loamium/migrate] smart-folders.json parse error: ${String(err)}`);
    return;
  }

  const parsed = smartViewConfigSchema.safeParse(raw);
  if (!parsed.success) {
    results.push(`smart-folders: schema invalid (${parsed.error.message}), skip`);
    console.error(`[loamium/migrate] smart-folders.json schema invalid: ${parsed.error.message}`);
    return;
  }

  const cfg = parsed.data;
  let migrated = 0;
  let skipped = 0;

  for (const item of cfg.items) {
    if (item.kind !== 'query') {
      // pin item は query を持たない。system/ には含めない。
      skipped++;
      continue;
    }

    const id = item.id;
    const destRel = `${SYSTEM_SMART_FOLDERS_DIR}/${id}.yaml`;
    const destAbs = path.join(vaultRoot, ...destRel.split('/'));

    if (await fileExists(destAbs)) {
      // 既に移行済み → スキップ (冪等)
      skipped++;
      continue;
    }

    // YAML 変換: title / icon / query (order は元の items 配列インデックス)
    const yamlObj: Record<string, unknown> = {
      query: item.dql,
    };
    if (item.name !== undefined && item.name !== '') {
      yamlObj.title = item.name;
    }
    if (item.icon !== undefined && item.icon !== '') {
      yamlObj.icon = item.icon;
    }

    const yamlText = stringifyYaml(yamlObj, { lineWidth: 0 });

    try {
      await writeUtf8Lf(destAbs, yamlText);
      await writeAuditEntry(config, {
        ts: new Date().toISOString(),
        op: 'migrate.smart-folder.write',
        path: destRel,
        mode: config.mode,
        result: 'ok',
        status: 200,
      });
      migrated++;
    } catch (err) {
      results.push(`smart-folders: failed to write ${destRel}: ${String(err)}`);
      console.error(`[loamium/migrate] failed to write ${destRel}: ${String(err)}`);
    }
  }

  results.push(`smart-folders: migrated=${migrated}, skipped=${skipped}`);
}

// ---- 2. テンプレート移行 ----

/**
 * templates/*.md を走査し、system/templates/*.md へコピーする。
 * ファイル名 (stem) で対応付け。
 * 旧パスのファイルはコピー元のまま残す (削除しない)。
 *
 * [AC-Sa10026-2-2]
 */
async function migrateTemplates(
  vaultRoot: string,
  config: ServerConfig,
  results: string[],
): Promise<void> {
  const oldDirAbs = path.join(vaultRoot, 'templates');
  if (!(await dirExists(oldDirAbs))) {
    results.push('templates: no templates/ dir found, skip');
    return;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(oldDirAbs, { withFileTypes: true });
  } catch (err) {
    results.push(`templates: failed to readdir templates/: ${String(err)}`);
    return;
  }

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (entry.name.startsWith('.')) continue;

    const srcAbs = path.join(oldDirAbs, entry.name);
    const destRel = `${SYSTEM_TEMPLATES_DIR}/${entry.name}`;
    const destAbs = path.join(vaultRoot, ...destRel.split('/'));

    if (await fileExists(destAbs)) {
      skipped++;
      continue;
    }

    try {
      const content = await fs.readFile(srcAbs, 'utf8');
      await writeUtf8Lf(destAbs, content);
      await writeAuditEntry(config, {
        ts: new Date().toISOString(),
        op: 'migrate.template.write',
        path: destRel,
        mode: config.mode,
        result: 'ok',
        status: 200,
      });
      migrated++;
    } catch (err) {
      results.push(`templates: failed to migrate ${entry.name}: ${String(err)}`);
      console.error(`[loamium/migrate] failed to migrate template ${entry.name}: ${String(err)}`);
    }
  }

  results.push(`templates: migrated=${migrated}, skipped=${skipped}`);
}

// ---- 3. コマンド移行 ----

/**
 * commands/*.yaml を走査し、system/commands/*.yaml へコピーする。
 * コマンドは既に YAML フォーマットであり変換不要 (パス移動のみ)。
 * .yml も対象。
 *
 * [AC-Sa10026-2-2]
 */
async function migrateCommands(
  vaultRoot: string,
  config: ServerConfig,
  results: string[],
): Promise<void> {
  const oldDirAbs = path.join(vaultRoot, 'commands');
  if (!(await dirExists(oldDirAbs))) {
    results.push('commands: no commands/ dir found, skip');
    return;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(oldDirAbs, { withFileTypes: true });
  } catch (err) {
    results.push(`commands: failed to readdir commands/: ${String(err)}`);
    return;
  }

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const srcAbs = path.join(oldDirAbs, entry.name);

    // 移行先は常に .yaml (統一)
    const stem = entry.name.replace(/\.ya?ml$/i, '');
    const destRel = `${SYSTEM_COMMANDS_DIR}/${stem}.yaml`;
    const destAbs = path.join(vaultRoot, ...destRel.split('/'));

    if (await fileExists(destAbs)) {
      skipped++;
      continue;
    }

    try {
      const content = await fs.readFile(srcAbs, 'utf8');
      await writeUtf8Lf(destAbs, content);
      await writeAuditEntry(config, {
        ts: new Date().toISOString(),
        op: 'migrate.command.write',
        path: destRel,
        mode: config.mode,
        result: 'ok',
        status: 200,
      });
      migrated++;
    } catch (err) {
      results.push(`commands: failed to migrate ${entry.name}: ${String(err)}`);
      console.error(`[loamium/migrate] failed to migrate command ${entry.name}: ${String(err)}`);
    }
  }

  results.push(`commands: migrated=${migrated}, skipped=${skipped}`);
}

// ---- エントリポイント ----

/**
 * 起動時に呼ばれる移行ランナー (Sa10026-2-1)。
 *
 * マーカーファイル (.loamium/migrate-Sa10026-2.done) が存在すれば全体をスキップし、
 * 存在しなければ3系統を移行してマーカーを書く。
 *
 * 冪等: マーカーがある場合は即リターン。
 *       マーカーがない場合も、個別ファイルは dest 存在チェックでスキップ (部分移行再実行安全)。
 *
 * エラーは console.error に記録するが、アプリ起動は止めない。
 *
 * [AC-Sa10026-2-1] [AC-Sa10026-2-3]
 */
export async function runMigration(config: ServerConfig): Promise<void> {
  const vaultRoot = config.vaultRoot;
  const markerAbs = path.join(vaultRoot, ...MARKER_REL.split('/'));

  // マーカーがあれば全体スキップ (冪等)
  if (await fileExists(markerAbs)) {
    return;
  }

  console.log('[loamium/migrate] starting Sa10026-2 migration...');
  const results: string[] = [];

  try {
    await migrateSmartFolders(vaultRoot, config, results);
  } catch (err) {
    console.error(`[loamium/migrate] smart-folders unexpected error: ${String(err)}`);
    results.push(`smart-folders: unexpected error: ${String(err)}`);
  }

  try {
    await migrateTemplates(vaultRoot, config, results);
  } catch (err) {
    console.error(`[loamium/migrate] templates unexpected error: ${String(err)}`);
    results.push(`templates: unexpected error: ${String(err)}`);
  }

  try {
    await migrateCommands(vaultRoot, config, results);
  } catch (err) {
    console.error(`[loamium/migrate] commands unexpected error: ${String(err)}`);
    results.push(`commands: unexpected error: ${String(err)}`);
  }

  // マーカー書き込み (次回以降はスキップ)
  try {
    await writeUtf8Lf(markerAbs, `${new Date().toISOString()}\n${results.join('\n')}\n`);
  } catch (err) {
    console.error(`[loamium/migrate] failed to write marker: ${String(err)}`);
  }

  console.log('[loamium/migrate] done:', results.join(' | '));
}
