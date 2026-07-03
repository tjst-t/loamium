/**
 * chokidar によるファイル監視 → インデックス差分更新。
 *
 * API を経由しない変更 (外部エディタ・Git checkout/pull 等) を検知して
 * インデックスに追従させる (VISION success_criteria / SPEC §9-1・§9-4)。
 * - .loamium/ .git/ などドット始まりのセグメントは監視除外
 * - .md 以外のファイルは無視
 * - インデックスは使い捨て・ファイルが正: イベント処理はファイル再読込のみで、
 *   失敗しても次のイベントや再起動時の全走査で自己修復する
 */
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { VaultIndex } from './noteIndex.js';

/** vault ルートからの相対パス (NFC / "/" 区切り) に変換。vault 外・隠しパスは null */
function toVaultRel(vaultRoot: string, absPath: string): string | null {
  const rel = path.relative(path.resolve(vaultRoot), absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/').normalize('NFC');
  if (posix.split('/').some((seg) => seg.startsWith('.'))) return null;
  return posix;
}

export function startWatcher(vaultRoot: string, index: VaultIndex): FSWatcher {
  const rootAbs = path.resolve(vaultRoot);
  const watcher = chokidar.watch(rootAbs, {
    ignoreInitial: true, // 起動時は VaultIndex.build() の全走査が済んでいる
    // ドット始まりのファイル/ディレクトリ (.loamium / .git / .obsidian) は監視自体から除外
    ignored: (p) => {
      const rel = path.relative(rootAbs, p);
      if (rel === '' || rel.startsWith('..')) return false;
      return rel.split(path.sep).some((seg) => seg.startsWith('.'));
    },
    // エディタの書き込み途中 (部分書き込み) を拾わない
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 20 },
  });

  const refresh = (absPath: string): void => {
    const rel = toVaultRel(rootAbs, absPath);
    if (rel === null || !rel.toLowerCase().endsWith('.md')) return;
    // absPath をヒントとして渡す: NFD ファイル名でも実パスで読める (インデックスキーは NFC)
    index.refreshFile(rel, absPath).catch((err: unknown) => {
      console.error(`[loamium] watch refresh failed for ${rel}:`, err);
    });
  };
  const remove = (absPath: string): void => {
    const rel = toVaultRel(rootAbs, absPath);
    if (rel === null || !rel.toLowerCase().endsWith('.md')) return;
    index.removeFile(rel);
  };

  watcher.on('add', refresh);
  watcher.on('change', refresh);
  watcher.on('unlink', remove);
  watcher.on('error', (err) => {
    // 監視エラーは握りつぶさない。インデックスは再起動で常に再構築できる
    console.error('[loamium] file watcher error:', err);
  });

  return watcher;
}
