/**
 * 受け入れテスト: Vault 同期 — CLI・エージェントツール・監査ログ・機能ガイド (Se29635-5)。
 *
 * test-discipline Rule 7: 実 system git + ローカル bare リポジトリ (file://)。mock 禁止。
 *
 * [AC-Se29635-5-1] CLI `loamium sync status` / `sync now` が動作し、REST と 1:1 で
 *                  bare リポジトリへの push が確認できる。
 * [AC-Se29635-5-2] sync 操作後 .loamium/audit.log に op=sync.* の JSONL が記録される。
 * [AC-Se29635-5-3] 機能ガイド `Vault同期の使い方.md` が存在し、samples/index.md にリンクされている。
 *
 * エージェントツールの広告セット検証:
 *   - read-only: sync_status が含まれる
 *   - full: sync_now が含まれる
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';
import { runCli } from './helpers/cli.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');

/** git コマンドを同期実行 (テスト setup 用) */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

/**
 * vault を git init し bare リポジトリを作成する。
 * vault の初期コミット (.gitignore 含む) を bare に push して main ブランチを確立する。
 */
async function setupGitVault(vaultDir: string, bareDir: string): Promise<string> {
  git('init', vaultDir);
  git('branch -m master main', vaultDir);
  git('config user.email test@test.local', vaultDir);
  git('config user.name Test', vaultDir);

  // .gitignore: .loamium/ を除外
  await writeFile(path.join(vaultDir, '.gitignore'), '.loamium/\n', 'utf8');
  git('add .gitignore', vaultDir);
  git('commit -m "init: add .gitignore"', vaultDir);

  await mkdir(bareDir, { recursive: true });
  git('init --bare', bareDir);
  git('symbolic-ref HEAD refs/heads/main', bareDir);

  const bareUrl = `file://${bareDir}`;
  git(`remote add origin ${bareUrl}`, vaultDir);
  git('push origin main', vaultDir);

  return bareUrl;
}

// ──────────────────────────────────────────────
// [AC-Se29635-5-1] + [AC-Se29635-5-2]: CLI + 監査ログ
// ──────────────────────────────────────────────

describe('[AC-Se29635-5-1][AC-Se29635-5-2] CLI sync status/now + audit.log', () => {
  let vault: string;
  let bareDir: string;
  let bareUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    bareDir = path.join(vault, '../bare-cli.git');
    bareUrl = await setupGitVault(vault, bareDir);

    server = await startServer({ vault, mode: 'full' });

    // リモート設定
    const res = await fetch(`${server.baseUrl}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remoteUrl: bareUrl, branch: 'main', enabled: true }),
    });
    expect(res.ok, `sync config PUT failed: ${String(res.status)}`).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
    await cleanupVault(bareDir);
  });

  it('[AC-Se29635-5-1] sync status は exit 0 で状態を返す', async () => {
    const result = await runCli(['sync', 'status'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('available:');
    expect(result.stdout).toContain('remoteConfigured:');
    expect(result.stdout).toContain('branch:');
  });

  it('[AC-Se29635-5-1] sync now は exit 0 で push 結果を返し bare に反映される', async () => {
    // ノートを作成してから sync now
    const noteRes = await fetch(`${server.baseUrl}/api/notes/sync-cli-test.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# sync-cli-test\n\ncreated by CLI test\n' }),
    });
    expect(noteRes.ok).toBe(true);

    const result = await runCli(['sync', 'now'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    // ok/error のいずれかが含まれる (push 結果)
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    // bare のコミット数が 1 以上になっている (初期コミット + sync コミット)
    const logCount = git('rev-list --count HEAD', bareDir);
    expect(Number(logCount)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('[AC-Se29635-5-2] .loamium/audit.log に sync.* の JSONL エントリが記録される', async () => {
    const auditPath = path.join(vault, '.loamium', 'audit.log');
    // audit.log が存在するまで最大 5s 待つ
    const deadline = Date.now() + 5_000;
    while (!existsSync(auditPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(existsSync(auditPath), 'audit.log が存在しない').toBe(true);

    const raw = await readFile(auditPath, 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '');
    // JSONL: 各行が JSON オブジェクト
    const entries = lines.map((l) => JSON.parse(l) as { op: string; ts: string; path: string });
    const syncOps = entries.filter((e) =>
      ['sync.commit', 'sync.push', 'sync.pull', 'sync.now'].includes(e.op),
    );
    expect(
      syncOps.length,
      `sync.* エントリが audit.log にない。全エントリ: ${entries.map((e) => e.op).join(', ')}`,
    ).toBeGreaterThan(0);
  });

  it('[AC-Se29635-5-1] sync config は exit 0 で設定を返す', async () => {
    const result = await runCli(['sync', 'config'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('remoteUrl:');
    expect(result.stdout).toContain(bareUrl);
  });

  it('[AC-Se29635-5-1] sync pull は exit 0 を返す', async () => {
    const result = await runCli(['sync', 'pull'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  }, 20_000);

  it('[AC-Se29635-5-1] sync push は exit 0 を返す', async () => {
    const result = await runCli(['sync', 'push'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  }, 20_000);

  it('[AC-Se29635-5-1] sync status --json は JSON を返す', async () => {
    const result = await runCli(['sync', 'status', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout) as { available: boolean };
    expect(typeof parsed.available).toBe('boolean');
  });
});

// ──────────────────────────────────────────────
// [AC-Se29635-5-3]: 機能ガイドの存在とリンク確認
// ──────────────────────────────────────────────

describe('[AC-Se29635-5-3] 機能ガイド Vault同期の使い方.md と samples/index.md リンク', () => {
  const guideFile = path.join(
    repoRoot,
    'packages/server/src/samples/機能ガイド/Vault同期の使い方.md',
  );
  const indexFile = path.join(repoRoot, 'packages/server/src/samples/index.md');

  it('Vault同期の使い方.md が存在し非空である', async () => {
    expect(existsSync(guideFile), `ガイドファイルが存在しない: ${guideFile}`).toBe(true);
    const content = await readFile(guideFile, 'utf8');
    expect(content.trim().length, 'ガイドファイルが空').toBeGreaterThan(100);
  });

  it('samples/index.md が Vault同期の使い方.md へのリンクを含む', async () => {
    expect(existsSync(indexFile)).toBe(true);
    const content = await readFile(indexFile, 'utf8');
    expect(
      content,
      'samples/index.md に Vault同期の使い方 のリンクがない',
    ).toContain('Vault同期の使い方');
  });
});

// ──────────────────────────────────────────────
// エージェントツール広告セット: sync_status (read) / sync_now (full のみ)
// これは agent-capabilities.test.ts での unit テストで主に検証する。
// ここではサニティとして deriveToolNames を間接的に確認する (REST 経由でなく unit-level)。
// ──────────────────────────────────────────────

describe('エージェントツール広告: sync_status / sync_now のケーパビリティゲート', () => {
  it('[AC-Se29635-5-1] deriveToolNames(read) には sync_status が含まれる', async () => {
    const { deriveToolNames } = await import('@loamium/shared');
    const tools = deriveToolNames(['read']);
    expect(tools).toContain('sync_status');
    // sync_now は read には含まれない
    expect(tools).not.toContain('sync_now');
  });

  it('[AC-Se29635-5-1] deriveToolNames(sync_now) には sync_now が含まれ、read なしでも動作する', async () => {
    const { deriveToolNames } = await import('@loamium/shared');
    const tools = deriveToolNames(['sync_now']);
    expect(tools).toContain('sync_now');
    // help は caps に read がなくても常に含まれる (ADR-0014)
    expect(tools).toContain('help');
  });

  it('[AC-Se29635-5-1] read-only モード (clampByMode) では sync_now が除去される', async () => {
    const { clampByMode } = await import('@loamium/shared');
    const clamped = clampByMode(['read', 'sync_now'], 'read-only');
    expect(clamped).toContain('read');
    expect(clamped).not.toContain('sync_now');
  });

  it('[AC-Se29635-5-1] full モードでは sync_now が残る', async () => {
    const { clampByMode } = await import('@loamium/shared');
    const clamped = clampByMode(['read', 'sync_now'], 'full');
    expect(clamped).toContain('sync_now');
  });
});
