/**
 * Playwright グローバルセットアップ。
 *
 * 1. 一時 vault を作成しフィクスチャノートをシード (E2E 用)
 * 2. 実サーバー (packages/server) を PORT=0 で起動し実ポートをパース
 *    (tests/acceptance/helpers/server.ts と同方式 — test-discipline Rule 2/7:
 *     実サーバー・本番モード。MOCK/fake モードは使わない)
 * 3. Vite dev server を空きポートで起動 (プロキシ先 LOAMIUM_API_URL=実サーバー)
 * 4. URL / PID / vault パスを tests/.harness-state.json に書き出す
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayJournalDate, shiftJournalDate, journalPath } from '@loamium/shared';
import { STATE_FILE, type HarnessState } from './state.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');
const viteBin = path.join(repoRoot, 'node_modules/.bin/vite');
const serverEntry = path.join(repoRoot, 'packages/server/src/index.ts');
const uiRoot = path.join(repoRoot, 'packages/ui');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not allocate a free port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function seedVault(vault: string): Promise<void> {
  const today = todayJournalDate();
  const files: Record<string, string> = {
    'projects/Loamium 開発ログ.md':
      '# Loamium 開発ログ\n\n- REST API は Sd63ad1 で実装済み\n- UI 基盤は Sa704c3\n',
    'projects/Hydra 設計メモ.md': '# Hydra 設計メモ\n\n自宅サーバーの再構成メモ。\n',
    'CodeMirror 6 調査.md': '# CodeMirror 6 調査\n\nlezer-markdown の構文木を使う。\n',
    // 過去のジャーナル (E2E の日付ナビゲーション用 — 今日から相対で作る)
    [journalPath(shiftJournalDate(today, -1))]: `# 昨日のジャーナル\n\n昨日のメモ。\n`,
    [journalPath(shiftJournalDate(today, -3))]: `# 3日前のジャーナル\n\n3日前のメモ。\n`,
    // 汎用テンプレート (S89a350-3 の E2E 用)
    'templates/議事録.md': [
      '---',
      'loamium-template:',
      '  description: 会議の議事録',
      '  target: "議事録/{{date:YYYY}}/{{date:MM}}/{{date:DD}}_{{会議名}}"',
      '  vars:',
      '    - name: 会議名',
      '      type: text',
      '      required: true',
      '    - name: 日付',
      '      type: date',
      '      default: "{{date:YYYY-MM-DD}}"',
      '    - name: カテゴリ',
      '      type: select',
      '      options: [定例, 臨時, その他]',
      '      default: 定例',
      '    - name: 参加者',
      '      type: tags',
      'カテゴリ: "{{カテゴリ}}"',
      '---',
      '# {{会議名}}',
      '',
      '参加者: {{参加者}}',
      '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

function waitForOutput(proc: ChildProcess, re: RegExp, label: string, timeoutMs: number): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not start within ${String(timeoutMs)}ms.\noutput: ${buf}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const m = re.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited early (code=${String(code)}).\noutput: ${buf}`));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ起動中
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} did not become ready`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export default async function globalSetup(): Promise<void> {
  const vault = await mkdtemp(path.join(tmpdir(), 'loamium-ui-vault-'));
  await seedVault(vault);

  // ---- 実サーバー ----
  const serverProc = spawn(tsxBin, [serverEntry], {
    // LOAMIUM_MAX_UPLOAD=5MB: サイズ超過エラーの実 E2E (upload.e2e) を、巨大ファイルを
    // 作らずに検証するため上限を絞る (本番既定は 50MB — AC-Sf53ad6-1-2)
    env: {
      ...process.env,
      LOAMIUM_VAULT: vault,
      LOAMIUM_MODE: 'full',
      PORT: '0',
      LOAMIUM_MAX_UPLOAD: '5mb',
      // ターミナル E2E (Sb7f458): 実シェルで有効化 (claude はログイン前提の外部依存)。
      // dotfile (starship 等) 非依存の決定論的プロンプトにするためラッパ経由で起動する
      // — 生の /bin/bash だと ~/.bashrc のプロンプトに引きずられ terminal specs が
      // 環境依存で落ちる (test-shell.sh 参照)。
      LOAMIUM_TERMINAL: '1',
      LOAMIUM_TERMINAL_CMD: path.join(uiRoot, 'tests/harness/test-shell.sh'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const m = await waitForOutput(serverProc, /listening on http:\/\/127\.0\.0\.1:(\d+)/, 'loamium server', 20_000);
  const apiPort = Number(m[1]);
  const apiUrl = `http://127.0.0.1:${String(apiPort)}`;
  await waitForHttp(`${apiUrl}/api/health`, 10_000);

  // ---- Vite dev server ----
  const uiPort = await freePort();
  const viteProc = spawn(viteBin, ['--port', String(uiPort), '--strictPort'], {
    cwd: uiRoot,
    env: { ...process.env, LOAMIUM_API_URL: apiUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  await waitForOutput(viteProc, /Local: {3}http:\/\/localhost:(\d+)/, 'vite dev server', 30_000);
  const uiUrl = `http://localhost:${String(uiPort)}`;
  await waitForHttp(uiUrl, 10_000);

  const state: HarnessState = {
    uiUrl,
    apiUrl,
    vault,
    serverPid: serverProc.pid ?? -1,
    vitePid: viteProc.pid ?? -1,
  };
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

  // 子プロセスの stdio を解放してランナー本体をブロックしない
  serverProc.unref();
  viteProc.unref();
}
