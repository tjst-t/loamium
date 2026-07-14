/**
 * アプリ全体設定 (`system/settings.yaml`) の読み書きストア (Sa10026-3-1)。
 *
 * ADR-0010 境界原則:
 * - `system/settings.yaml` は「versioning + 移植 + 人/agent 編集したい」設定のみを含む。
 * - 端末固有・再構築可能な状態 (インデックスキャッシュ / ペイン幅 / 最後に開いたノート等)
 *   は `.loamium/` に残す — このファイルには入れない。[AC-Sa10026-3-2]
 *
 * 設計方針:
 * - ファイル不在 → 既定値で返す (ENOENT は警告なし)。[AC-Sa10026-3-1]
 * - 壊れた YAML / スキーマ不合格 → 既定値で返す (console.error のみ)。[AC-Sa10026-3-1]
 * - 決して例外を投げない (loadSettings) — priority 6: アプリを止めない。
 * - 書き込みは UTF-8 / LF 固定 (VISION tech_constraints)。
 * - 書き込みは監査ログ (`.loamium/audit.log`) に記録する (DESIGN_PRINCIPLES)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toLf } from '@loamium/shared';
import {
  SYSTEM_SETTINGS_PATH,
  parseAppSettings,
  serializeAppSettings,
  type AppSettings,
} from '@loamium/shared';
import { resolveVaultFile } from './vault.js';

// ---- 読み込み ----

/**
 * `system/settings.yaml` を読み込み `AppSettings` を返す (寛容 read)。
 *
 * - ファイル不在 (ENOENT) → 既定値を返す (ログなし)。
 * - 読み取りエラー / 壊れた YAML / スキーマ不合格 → 既定値を返す (console.error)。
 * - この関数は決して例外を投げない。[AC-Sa10026-3-1]
 */
export async function loadSettings(vaultRoot: string): Promise<AppSettings> {
  let abs: string;
  try {
    abs = resolveVaultFile(vaultRoot, SYSTEM_SETTINGS_PATH);
  } catch (err) {
    console.error(`[loamium/settings-store] containment error for settings path: ${String(err)}`);
    return parseAppSettings(null);
  }

  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch (err) {
    const isEnoent =
      err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.error(`[loamium/settings-store] failed to read settings.yaml: ${String(err)}`);
    }
    // ENOENT は正常 (初回 / 設定未作成) — parseAppSettings(null) が既定を返す
    return parseAppSettings(null);
  }

  // parseAppSettings が YAML パースエラー / スキーマ不合格を吸収して既定へ落とす
  return parseAppSettings(text);
}

// ---- 書き込み ----

/**
 * `AppSettings` を `system/settings.yaml` へ書き込む。
 *
 * - 親ディレクトリ (system/) を自動作成する。
 * - UTF-8 / LF 固定。
 * - 書き込み後の mtime を返す (楽観的競合検出用)。
 * - 失敗した場合は例外を投げる (呼び出し側がハンドリングする)。
 *
 * [AC-Sa10026-3-1]
 */
export async function saveSettings(
  vaultRoot: string,
  settings: AppSettings,
): Promise<{ created: boolean; mtime: number }> {
  const abs = resolveVaultFile(vaultRoot, SYSTEM_SETTINGS_PATH);

  let existed = false;
  try {
    const st = await fs.stat(abs);
    existed = st.isFile();
  } catch {
    existed = false;
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  const content = serializeAppSettings(settings);
  await fs.writeFile(abs, toLf(content), 'utf8');
  const st = await fs.stat(abs);
  return { created: !existed, mtime: Math.trunc(st.mtimeMs) };
}
