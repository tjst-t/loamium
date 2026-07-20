/**
 * サーバーのアプリバージョンを解決する。
 *
 * 解決順:
 *   1. LOAMIUM_VERSION 環境変数 (CI がタグ `vX.Y.Z` から設定 / Docker の ENV)
 *   2. ルート package.json の version (native / npm 起動時)
 *
 * git には依存しない (Docker / 単体バイナリなど git の無い実行環境を想定)。
 * 解決できなければ undefined を返す (health レスポンスでは optional)。
 * UI 表示は vite.config.ts のビルド時埋め込みが正 (こちらは API 参照用)。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cached: string | null | undefined;

function normalize(v: string): string {
  return v.startsWith('v') ? v : `v${v}`;
}

/**
 * env とルート package.json の version からバージョン文字列を選ぶ純粋関数。
 * env を優先し、いずれも空なら undefined。先頭に `v` を付与して正規化する。
 * (I/O を切り離してテスト可能にするため export する)
 */
export function chooseVersion(
  envVersion: string | undefined,
  pkgVersion: string | undefined,
): string | undefined {
  const env = envVersion?.trim();
  if (env !== undefined && env !== '') return normalize(env);
  const pkg = pkgVersion?.trim();
  if (pkg !== undefined && pkg !== '') return normalize(pkg);
  return undefined;
}

function readPkgVersion(): string | undefined {
  try {
    // packages/server/src/app-version.ts → リポジトリ / デプロイルートの package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRaw = readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    // package.json が読めない環境 (単体バイナリ等) は未解決
    return undefined;
  }
}

export function resolveServerVersion(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = chooseVersion(process.env.LOAMIUM_VERSION, readPkgVersion()) ?? null;
  return cached ?? undefined;
}
