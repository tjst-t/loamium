/**
 * globalSetup とテストの間で共有するハーネス状態。
 * (globalSetup はランナーと別プロセスのため、ファイル経由で受け渡す)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HarnessState {
  uiUrl: string;
  apiUrl: string;
  vault: string;
  serverPid: number;
  vitePid: number;
}

export const STATE_FILE = path.resolve(
  fileURLToPath(import.meta.url),
  '../../.harness-state.json',
);

export function readHarnessState(): HarnessState {
  const raw: unknown = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('uiUrl' in raw) ||
    !('apiUrl' in raw) ||
    !('vault' in raw)
  ) {
    throw new Error('invalid harness state — run via `playwright test` so globalSetup executes');
  }
  return raw as HarnessState;
}
