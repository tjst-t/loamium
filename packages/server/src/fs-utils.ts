import { mkdir } from 'node:fs/promises';

/**
 * `fs.mkdir(dir, { recursive: true })` の EEXIST 安全ラッパー。
 *
 * bun on Windows は既存ディレクトリに対して `mkdir(recursive:true)` が EEXIST を投げる
 * (Node.js は無視する) 差異がある。パッケージ済みサーバー (`loamium-server.exe`) は
 * `bun build --compile` バイナリのため、この差異で settings/notes/smart-folder 等あらゆる
 * 書き込み系が `Error: EEXIST: file already exists, mkdir '...'` で落ちる
 * (特に OneDrive 等、初回に `.loamium` が既に作られている vault で顕在化)。
 *
 * EEXIST を握りつぶし「ディレクトリが存在すること」だけを保証する (bun / Node.js 両対応)。
 * それ以外のエラー (権限・親がファイル等) はそのまま投げる。
 */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'EEXIST'
    ) {
      return;
    }
    throw err;
  }
}
