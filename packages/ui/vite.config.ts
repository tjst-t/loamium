/**
 * Vite 設定。/api を Loamium サーバー (Hono) にプロキシする。
 *
 * プロキシ先の解決順 (ポートはハードコードしない — CLAUDE.md):
 *   1. LOAMIUM_API_URL 環境変数 (テストハーネス / make serve-ui が設定)
 *   2. `portman lease --name loamium` で開発サーバーのポートを取得
 *   3. 最後の手段として CLI と同じ既定値 http://127.0.0.1:3000
 */
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
 *   LOAMIUM_UI_ALLOWED_HOSTS=all           … すべてのホストを許可 (保護を無効化)
 *   LOAMIUM_UI_ALLOWED_HOSTS=.example.com  … example.com と全サブドメインを許可
 *   LOAMIUM_UI_ALLOWED_HOSTS=a.example.com,b.example.com  … カンマ区切りで個別に
 *   未設定                                  … 既定 (localhost / IP アドレスのみ。ドメインは拒否)
 */
function allowedHosts(): true | string[] {
  const raw = process.env.LOAMIUM_UI_ALLOWED_HOSTS?.trim();
  if (raw === undefined || raw === '') return [];
  if (raw === 'all' || raw === 'true' || raw === '*') return true;
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
}

export default defineConfig({
  plugins: [react()],
  server: {
    // 既定は localhost / IP のみ。プロキシのドメイン経由で使うときは
    // LOAMIUM_UI_ALLOWED_HOSTS に許可ホスト (例: .tjstkm.net) を指定する。
    allowedHosts: allowedHosts(),
    proxy: {
      '/api': {
        target: apiTarget(),
        changeOrigin: true,
        // WS /api/terminal (Sb7f458) も同じプロキシで通す
        ws: true,
      },
    },
  },
});
