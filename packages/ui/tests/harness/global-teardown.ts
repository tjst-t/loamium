/**
 * Playwright グローバルティアダウン: サーバー / Vite を停止し一時 vault を削除。
 */
import { rm } from 'node:fs/promises';
import { readHarnessState, STATE_FILE } from './state.js';

function tryKill(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // 既に終了している場合 (ESRCH) は無視してよい
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

export default async function globalTeardown(): Promise<void> {
  let state: ReturnType<typeof readHarnessState> | null = null;
  try {
    state = readHarnessState();
  } catch (err) {
    // globalSetup が失敗した場合は片付けるものが無い
    void err;
    return;
  }
  tryKill(state.vitePid);
  tryKill(state.serverPid);
  await rm(state.vault, { recursive: true, force: true });
  await rm(STATE_FILE, { force: true });
}
