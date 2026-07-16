# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packages/ui/tests/e2e/settings-hub-templates.mock.spec.ts >> [AC-Sa100c6-1-1] 設定グループ(general)パネルは引き続き表示される
- Location: packages/ui/tests/e2e/settings-hub-templates.mock.spec.ts:183:1

# Error details

```
Error: ENOENT: no such file or directory, open '/home/ubuntu/ghq/github.com/tjst-t/loamium/packages/ui/tests/.harness-state.json'
```

# Test source

```ts
  1  | /**
  2  |  * globalSetup とテストの間で共有するハーネス状態。
  3  |  * (globalSetup はランナーと別プロセスのため、ファイル経由で受け渡す)
  4  |  */
  5  | import { readFileSync } from 'node:fs';
  6  | import path from 'node:path';
  7  | import { fileURLToPath } from 'node:url';
  8  | 
  9  | export interface HarnessState {
  10 |   uiUrl: string;
  11 |   apiUrl: string;
  12 |   vault: string;
  13 |   serverPid: number;
  14 |   vitePid: number;
  15 | }
  16 | 
  17 | export const STATE_FILE = path.resolve(
  18 |   fileURLToPath(import.meta.url),
  19 |   '../../.harness-state.json',
  20 | );
  21 | 
  22 | export function readHarnessState(): HarnessState {
> 23 |   const raw: unknown = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
     |                                   ^ Error: ENOENT: no such file or directory, open '/home/ubuntu/ghq/github.com/tjst-t/loamium/packages/ui/tests/.harness-state.json'
  24 |   if (
  25 |     typeof raw !== 'object' ||
  26 |     raw === null ||
  27 |     !('uiUrl' in raw) ||
  28 |     !('apiUrl' in raw) ||
  29 |     !('vault' in raw)
  30 |   ) {
  31 |     throw new Error('invalid harness state — run via `playwright test` so globalSetup executes');
  32 |   }
  33 |   return raw as HarnessState;
  34 | }
  35 | 
```