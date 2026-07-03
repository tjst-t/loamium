/**
 * サーバー URL の解決。優先順は ROADMAP (task S0c9a48-1-1) 指定のとおり:
 *
 *   1. LOAMIUM_URL 環境変数
 *   2. `portman port --name loamium` (portman 管理のポート)
 *   3. デフォルト http://127.0.0.1:3000 (packages/server/src/index.ts の既定と同一)
 *
 * portman が存在しない・失敗する・出力がポート番号でない場合は黙って次へ
 * フォールバックする (CLI 利用者に portman は必須ではない)。
 */
import { execFile } from 'node:child_process';

export const DEFAULT_URL = 'http://127.0.0.1:3000';

/** 末尾スラッシュを除去する (パス連結を単純化)。 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `portman port --name loamium` からポート番号を取得する。失敗時は null。 */
function portFromPortman(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('portman', ['port', '--name', 'loamium'], { timeout: 3_000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const out = stdout.trim();
      if (!/^\d+$/.test(out)) {
        resolve(null);
        return;
      }
      const port = Number(out);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        resolve(null);
        return;
      }
      resolve(port);
    });
  });
}

export async function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env.LOAMIUM_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return stripTrailingSlash(fromEnv.trim());
  }
  const port = await portFromPortman();
  if (port !== null) {
    return `http://127.0.0.1:${port}`;
  }
  return DEFAULT_URL;
}
