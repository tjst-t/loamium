/**
 * Vite 設定。/api を Loamium サーバー (Hono) にプロキシする。
 *
 * プロキシ先の解決順 (ポートはハードコードしない — CLAUDE.md):
 *   1. LOAMIUM_API_URL 環境変数 (テストハーネス / make serve-ui が設定)
 *   2. `portman lease --name loamium` で開発サーバーのポートを取得
 *   3. 最後の手段として CLI と同じ既定値 http://127.0.0.1:3000
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * アプリのバージョン文字列を解決する (ビルド時に UI へ埋め込む)。
 * 解決順:
 *   1. LOAMIUM_VERSION 環境変数 (CI がタグ `vX.Y.Z` から設定 / Docker build-arg)
 *   2. `git describe --tags` (開発時。例 v0.1.0-111-gd05f5d7)
 *   3. ルート package.json の version (git が無い環境のフォールバック)
 * 先頭に `v` が無ければ付与して正規化する。
 * サーバー側 (`app.ts` の /api/health) にも同等の解決ロジックがある。
 */
function resolveAppVersion(): string {
  const normalize = (v: string): string => (v.startsWith('v') ? v : `v${v}`);
  const fromEnv = process.env.LOAMIUM_VERSION?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return normalize(fromEnv);
  try {
    const described = execSync('git describe --tags --always', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (described !== '') return normalize(described);
  } catch {
    // git が無い / タグが無い環境は package.json へフォールバック
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRaw = readFileSync(join(here, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version !== '') {
      return normalize(pkg.version);
    }
  } catch {
    // 最終フォールバック
  }
  return 'v0.0.0-dev';
}

function apiTarget(): string {
  const fromEnv = process.env.LOAMIUM_API_URL;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const out = execSync('portman lease --name loamium', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+$/.test(out)) return `http://127.0.0.1:${out}`;
  } catch {
    // portman が無い環境 (CI 等) は既定値へフォールバック
  }
  return 'http://127.0.0.1:3000';
}

/**
 * 許可する Host ヘッダ (Vite の DNS リバインディング対策)。
 * リバースプロキシ (Caddy 等) のサブドメイン経由で開くと、既定では
 * "Blocked request. This host is not allowed" になるため、環境変数で許可する。
 *
 *   LOAMIUM_UI_ALLOWED_HOSTS=all              … すべてのホストを許可 (保護を無効化)
 *   LOAMIUM_UI_ALLOWED_HOSTS=.example.com     … example.com と全サブドメインを許可
 *   LOAMIUM_UI_ALLOWED_HOSTS=*.example.com    … 同上 (ターミナル側 ORIGINS と同じ記法も可)
 *   LOAMIUM_UI_ALLOWED_HOSTS=https://*.example.com … scheme 付き origin 形式も可 (host だけ使う)
 *   LOAMIUM_UI_ALLOWED_HOSTS=a.example.com,b.example.com  … カンマ区切りで個別に
 *   未設定                                     … 既定 (localhost / IP アドレスのみ。ドメインは拒否)
 */
function normalizeUiAllowedHost(entry: string): string {
  // origin 形式 (https://host) で貼られたら host 部だけ取る
  const sep = entry.indexOf('://');
  const host = sep === -1 ? entry : entry.slice(sep + 3);
  // LOAMIUM_UI_ALLOWED_HOSTS の "*.example.com" 記法を
  // Vite が解釈する先頭ドット ".example.com" へ変換する (記法を統一)
  return host.startsWith('*.') ? host.slice(1) : host;
}

export function parseUiAllowedHosts(raw: string | undefined): true | string[] {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return [];
  if (trimmed === 'all' || trimmed === 'true' || trimmed === '*') return true;
  return trimmed
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '')
    .map(normalizeUiAllowedHost);
}

function allowedHosts(): true | string[] {
  return parseUiAllowedHosts(process.env.LOAMIUM_UI_ALLOWED_HOSTS);
}

export default defineConfig({
  plugins: [react()],
  // ビルド時にバージョン文字列を埋め込む (グローバル __APP_VERSION__)。
  // ロゴ右のバージョン表示や将来のデバッグ用途で参照する。
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  server: {
    // 既定は localhost / IP のみ。プロキシのドメイン経由で使うときは
    // LOAMIUM_UI_ALLOWED_HOSTS に許可ホスト (例: .tjstkm.net) を指定する。
    allowedHosts: allowedHosts(),
    proxy: {
      '/api': {
        target: apiTarget(),
        changeOrigin: true,
        // ws: true — 将来の WS エンドポイント用に維持
        ws: true,
      },
    },
  },
});
