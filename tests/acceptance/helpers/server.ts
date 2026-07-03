/**
 * 受け入れテスト用サーバーハーネス。
 *
 * test-discipline Rule 2 (api): 実サーバーをサブプロセスとして起動し、
 * 実 HTTP クライアント (fetch) で叩く。ハンドラ直接呼び出しはしない。
 * vault はテストごとの一時ディレクトリ (CLAUDE.md: dev-vault は使わない)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const serverEntry = path.join(repoRoot, 'packages/server/src/index.ts');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');

export interface TestServer {
  baseUrl: string;
  vault: string;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export async function makeTempVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'loamium-vault-'));
}

/**
 * 実サーバーを起動する。PORT=0 で空きポートを OS に割り当てさせ、
 * stdout の listening 行から実ポートをパースする。
 */
export async function startServer(options: {
  vault: string;
  mode?: 'full' | 'read-only' | 'append-only';
}): Promise<TestServer> {
  const proc = spawn(tsxBin, [serverEntry], {
    env: {
      ...process.env,
      LOAMIUM_VAULT: options.vault,
      LOAMIUM_MODE: options.mode ?? 'full',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  const port = await new Promise<number>((resolve, reject) => {
    let stdoutBuf = '';
    const timer = setTimeout(() => {
      reject(
        new Error(`server did not start within 15s.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`),
      );
    }, 15_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdoutBuf);
      if (m && m[1]) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code=${code}).\nstderr: ${stderrBuf}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  // health チェックで受付可能になるまで待つ
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) break;
    } catch {
      // まだ起動中
    }
    if (Date.now() > deadline) {
      throw new Error('server health check did not become ready within 10s');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    baseUrl,
    vault: options.vault,
    proc,
    stop: async () => {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 3_000);
        proc.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

export async function cleanupVault(vault: string): Promise<void> {
  await rm(vault, { recursive: true, force: true });
}
