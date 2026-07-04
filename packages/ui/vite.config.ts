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

export default defineConfig({
  plugins: [react()],
  server: {
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
