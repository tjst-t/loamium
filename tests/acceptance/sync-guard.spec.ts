/**
 * 受け入れテスト: vault が git リポジトリでない場合、親リポジトリを誤操作しない (Se29635 バグ修正)。
 *
 * 実バグ再現: dev-vault のように vault が git リポジトリでなく、かつ親ディレクトリが
 * 別の git リポジトリ (アプリ本体) の場合、素朴にシェルアウトすると git が親を探索し、
 * 親リポジトリの remote 変更・commit・push を誤って実行してしまう。
 * エンジンは GIT_CEILING_DIRECTORIES で親探索を打ち切り、status().vaultIsRepo=false を返す。
 *
 * test-discipline Rule 7: 実 system git。mock 禁止。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type TestServer } from './helpers/server.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const SENTINEL_REMOTE = 'file:///tmp/sentinel-parent-remote.git';

let parentDir: string;
let vaultDir: string;
let server: TestServer;

describe('[Se29635 バグ修正] vault が git リポジトリでない場合は親リポジトリを触らない', () => {
  beforeAll(async () => {
    // 親ディレクトリを git リポジトリにする (アプリ本体リポジトリ相当)
    parentDir = await mkdtemp(path.join(tmpdir(), 'loamium-parentrepo-'));
    git(['init'], parentDir);
    git(['branch', '-m', 'master', 'main'], parentDir);
    git(['config', 'user.email', 'parent@test.local'], parentDir);
    git(['config', 'user.name', 'Parent'], parentDir);
    git(['remote', 'add', 'origin', SENTINEL_REMOTE], parentDir);
    await writeFile(path.join(parentDir, 'app.txt'), 'application source\n', 'utf8');
    git(['add', '-A'], parentDir);
    git(['commit', '-m', 'parent: initial'], parentDir);

    // vault は親の中のサブディレクトリで、それ自身は git リポジトリではない (dev-vault 相当)
    vaultDir = path.join(parentDir, 'vault');
    await mkdir(vaultDir, { recursive: true });
    await writeFile(path.join(vaultDir, 'note.md'), '# note\n', 'utf8');

    server = await startServer({ vault: vaultDir });
  });

  afterAll(async () => {
    await server.stop();
    await rm(parentDir, { recursive: true, force: true });
  });

  it('GET /api/sync/status は vaultIsRepo:false を返す', async () => {
    const res = await fetch(`${server.baseUrl}/api/sync/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; vaultIsRepo: boolean; lastError: string | null };
    expect(body.available).toBe(true); // git バイナリはある
    expect(body.vaultIsRepo).toBe(false); // vault は repo でない
    expect(body.lastError).toContain('git リポジトリ');
  });

  it('PUT /api/sync/config (configureRemote) は親リポジトリの origin を書き換えない', async () => {
    const before = git(['remote', 'get-url', 'origin'], parentDir);
    expect(before).toBe(SENTINEL_REMOTE);

    // 設定保存 → configureRemote が走る (素朴実装なら親の origin を set-url してしまう)
    const res = await fetch(`${server.baseUrl}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, remoteUrl: 'file:///tmp/some-vault-remote.git', branch: 'main' }),
    });
    expect(res.status).toBe(200);

    // 親リポジトリの origin は不変であること (誤操作していない)
    const after = git(['remote', 'get-url', 'origin'], parentDir);
    expect(after).toBe(SENTINEL_REMOTE);
  });

  it('POST /api/sync/now は親リポジトリに commit を作らない', async () => {
    const before = git(['rev-list', '--count', 'HEAD'], parentDir);

    const res = await fetch(`${server.baseUrl}/api/sync/now`, { method: 'POST' });
    // 実行はされる (200) が、親では何も起きない
    expect([200, 500]).toContain(res.status);

    const after = git(['rev-list', '--count', 'HEAD'], parentDir);
    expect(after).toBe(before); // 親のコミット数は不変
  });
});
