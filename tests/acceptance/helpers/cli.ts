/**
 * CLI 受け入れテスト用ランナー。
 *
 * test-discipline Rule 2 (cli): 実際に配布される bin エントリ
 * (packages/cli/bin/loamium.js) をサブプロセスとして起動し、
 * stdout / stderr / exit code を観測する。src を import しての in-process 実行はしない。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
export const cliBin = path.join(repoRoot, 'packages/cli/bin/loamium.js');

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  /** 子プロセスの環境変数 (完全置換ではなく process.env にマージ)。 */
  env?: Record<string, string>;
  /** true のとき LOAMIUM_URL を子プロセス環境から取り除く (URL 解決順テスト用)。 */
  unsetLoamiumUrl?: boolean;
}

export function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  if (options.unsetLoamiumUrl === true) {
    delete env.LOAMIUM_URL;
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cliBin, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`loamium CLI did not exit within 20s: loamium ${args.join(' ')}`));
    }, 20_000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** stderr の 1 行 JSON エラー ({error, message}) をパースする。 */
export function parseStderrJson(stderr: string): { error: string; message: string } {
  const line = stderr.trim();
  const parsed = JSON.parse(line) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { error?: unknown }).error !== 'string' ||
    typeof (parsed as { message?: unknown }).message !== 'string'
  ) {
    throw new Error(`stderr is not a machine-readable {error,message} JSON: ${stderr}`);
  }
  return parsed as { error: string; message: string };
}
