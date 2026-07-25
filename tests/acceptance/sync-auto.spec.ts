/**
 * 受け入れテスト: 自動同期 (デバウンス) + フォーカス/定期 pull + オフラインキュー (Se29635-3)。
 *
 * test-discipline Rule 7: 実 system git + ローカル bare リポジトリ (file://)。mock 禁止。
 *
 * [AC-Se29635-3-1] 編集停止デバウンスで auto-commit → push される
 * [AC-Se29635-3-2] pull は起動時・フォーカス時 (POST /api/sync/pull reason:focus) で走る
 * [AC-Se29635-3-3] オフライン時は失敗を握りつぶさずキューし、復帰時にリトライして解消する
 *
 * ## タイミング安定化の方針
 * - 固定 sleep ではなく **条件ポーリング + タイムアウト** を使う。
 * - debounceMs はテスト用に 300ms に短縮する。
 * - pollUntil() ヘルパーが true を返すまで最大 timeout_ms 待機する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

// ──────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────

/** git コマンドを同期実行する (テスト setup 用)。 */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

/**
 * condition が true を返すまで interval ごとにポーリングし、
 * timeout_ms 経過したら false を返す。
 */
async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return true;
    } catch {
      // 条件評価エラーは無視してリトライする
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * vault を git init し bare リポジトリを作成する。
 * vault の初期コミットを bare に push して bare に `main` ブランチを確立する。
 */
async function setupGitVault(vaultDir: string, bareDir: string): Promise<string> {
  git('init', vaultDir);
  git('branch -m master main', vaultDir);
  git('config user.email test@test.local', vaultDir);
  git('config user.name Test', vaultDir);

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

/**
 * 指定ファイルを bare に push するクローンヘルパー。
 */
async function pushFromCloneWithFile(
  bareUrl: string,
  cloneDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  await mkdir(cloneDir, { recursive: true });
  git(`clone ${bareUrl} .`, cloneDir);
  git('checkout main', cloneDir);
  git('config user.email test@test.local', cloneDir);
  git('config user.name Test', cloneDir);

  const absPath = path.join(cloneDir, relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, content, 'utf8');
  git('add -A', cloneDir);
  git(`commit -m "add ${relPath}"`, cloneDir);
  git('push origin main', cloneDir);
}

/** autoSync を短縮 debounce で有効化するヘルパー。 */
async function enableAutoSync(baseUrl: string, bareUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/sync/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      autoSync: true,
      remoteUrl: bareUrl,
      branch: 'main',
      debounceMs: 300,           // テスト用短縮 (本番 30000)
      pullIntervalMs: 3_600_000, // テスト中に発火しないよう大きい値に設定
    }),
  });
  expect(res.status).toBe(200);
}

// ──────────────────────────────────────────────
// Scenario 1 — [AC-Se29635-3-1] + [AC-Se29635-3-2]
// ──────────────────────────────────────────────

describe('Scenario 1: デバウンス auto-commit/push + フォーカス pull', () => {
  let vault: string;
  let bareDir: string;
  let cloneDir: string;
  let bareUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    bareDir = `${vault}-hub.git`;
    cloneDir = `${vault}-clone-b2`;
    bareUrl = await setupGitVault(vault, bareDir);

    server = await startServer({ vault, mode: 'full' });

    // autoSync を有効化して debounce を短縮する
    await enableAutoSync(server.baseUrl, bareUrl);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
    await cleanupVault(bareDir).catch(() => { /* ignore */ });
    await cleanupVault(cloneDir).catch(() => { /* ignore */ });
  });

  it('[AC-Se29635-3-1] 編集停止のデバウンス後に auto-commit→push され bare に反映される', async () => {
    // ノートを作成する (debounce をトリガーする)
    const noteRes = await fetch(`${server.baseUrl}/api/notes/notes/auto.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# auto-sync test\n\nThis should be auto-pushed.\n' }),
    });
    expect([200, 201]).toContain(noteRes.status);

    // bare に auto.md が現れるまでポーリングする (debounce 300ms + push 余裕 10s)
    const appeared = await pollUntil(() => {
      try {
        const ls = execSync(
          `git --git-dir="${bareDir}" ls-tree -r --name-only main`,
          { encoding: 'utf8' },
        );
        return ls.includes('notes/auto.md');
      } catch {
        return false;
      }
    }, 10_000);

    expect(appeared).toBe(true);

    // status を確認する: ahead=0 かつ lastSyncAt が非 null
    const statusRes = await fetch(`${server.baseUrl}/api/sync/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as Record<string, unknown>;
    expect(status.ahead).toBe(0);
    expect(status.lastSyncAt).not.toBeNull();
  });

  it('[AC-Se29635-3-2] 別端末が bare に push した後、POST /api/sync/pull reason:focus で取り込まれる', async () => {
    // 端末B: from-b2.md を bare に push する
    await pushFromCloneWithFile(
      bareUrl,
      cloneDir,
      'notes/from-b2.md',
      '# from-b2\n\nFrom terminal B second device.\n',
    );

    // フォーカス pull
    const pullRes = await fetch(`${server.baseUrl}/api/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'focus' }),
    });
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as Record<string, unknown>;
    expect(pullBody.ok).toBe(true);

    // vault に from-b2.md が存在することを確認する
    const fromB2Path = path.join(vault, 'notes', 'from-b2.md');
    const content = await readFile(fromB2Path, 'utf8');
    expect(content).toContain('from-b2');

    // インデックスに反映されるまでポーリングする (watcher 非同期)
    const indexed = await pollUntil(async () => {
      const searchRes = await fetch(`${server.baseUrl}/api/notes?q=from-b2`);
      if (!searchRes.ok) return false;
      const body = (await searchRes.json()) as Record<string, unknown>;
      const notes = body.notes as Array<Record<string, unknown>>;
      return notes.some((n) => String(n.path ?? '').includes('from-b2'));
    }, 5_000);
    expect(indexed).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Scenario 2 — [AC-Se29635-3-3] オフラインキュー
// ──────────────────────────────────────────────

describe('Scenario 2: オフラインキュー — 失敗を握りつぶさずキューし、復帰時にリトライする', () => {
  let vault: string;
  let bareDir: string;
  let bareUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    bareDir = `${vault}-hub2.git`;
    bareUrl = await setupGitVault(vault, bareDir);

    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
    await cleanupVault(bareDir).catch(() => { /* ignore */ });
  });

  it('[AC-Se29635-3-3] リモート到達不能時は offline=true/queued>=1/lastError が設定される', async () => {
    // 到達不能な file:// bare URL に向ける
    const badUrl = `file:///tmp/loamium-nonexistent-bare-${Date.now()}.git`;
    const cfgRes = await fetch(`${server.baseUrl}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        autoSync: true,
        remoteUrl: badUrl,
        branch: 'main',
        debounceMs: 300,
        pullIntervalMs: 3_600_000,
      }),
    });
    expect(cfgRes.status).toBe(200);

    // ノートを編集して auto-sync を発火させる
    const noteRes = await fetch(`${server.baseUrl}/api/notes/notes/offline-test.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# offline queue test\n\nShould be queued.\n' }),
    });
    expect([200, 201]).toContain(noteRes.status);

    // debounce 完了まで待機後に POST /api/sync/now で明示的に発火させる
    // (debounce 後の auto-sync でも良いが明示呼び出しで確実に発火させる)
    await new Promise<void>((r) => setTimeout(r, 500));
    const nowRes = await fetch(`${server.baseUrl}/api/sync/now`, { method: 'POST' });
    expect(nowRes.status).toBe(200);

    // status をポーリングして offline=true かつ queued>=1 を確認する
    let lastStatus: Record<string, unknown> = {};
    const wentOffline = await pollUntil(async () => {
      const statusRes = await fetch(`${server.baseUrl}/api/sync/status`);
      if (!statusRes.ok) return false;
      const status = (await statusRes.json()) as Record<string, unknown>;
      lastStatus = status;
      return (
        status.offline === true &&
        typeof status.queued === 'number' &&
        (status.queued as number) >= 1
      );
    }, 10_000);

    expect(wentOffline).toBe(true);
    expect(lastStatus.offline).toBe(true);
    expect(typeof lastStatus.queued === 'number' && (lastStatus.queued as number) >= 1).toBe(true);
    expect(lastStatus.lastError).not.toBeNull();
  });

  it('[AC-Se29635-3-3] リモートを正しい bare に戻して POST /api/sync/now で queued が解消される', async () => {
    // 正しい bare URL に戻す
    const cfgRes = await fetch(`${server.baseUrl}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remoteUrl: bareUrl,
        enabled: true,
        autoSync: true,
        debounceMs: 300,
        pullIntervalMs: 3_600_000,
      }),
    });
    expect(cfgRes.status).toBe(200);

    // 今すぐ同期
    const nowRes = await fetch(`${server.baseUrl}/api/sync/now`, { method: 'POST' });
    expect(nowRes.status).toBe(200);

    // offline=false かつ queued=0 になるまでポーリングする
    const recovered = await pollUntil(async () => {
      const statusRes = await fetch(`${server.baseUrl}/api/sync/status`);
      if (!statusRes.ok) return false;
      const status = (await statusRes.json()) as Record<string, unknown>;
      return status.offline === false && status.queued === 0;
    }, 10_000);

    expect(recovered).toBe(true);

    // bare の main tip にキューされていたファイルが反映されていることを確認する
    const ls = execSync(
      `git --git-dir="${bareDir}" ls-tree -r --name-only main`,
      { encoding: 'utf8' },
    );
    expect(ls).toContain('notes/offline-test.md');
  });
});

// ──────────────────────────────────────────────
// Scenario 3 — [AC-Se29635-3-1] POST /api/sync/flush
// ──────────────────────────────────────────────

describe('Scenario 3: POST /api/sync/flush でブラー時の pending debounce を即時実行する', () => {
  let vault: string;
  let bareDir: string;
  let bareUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    bareDir = `${vault}-hub3.git`;
    bareUrl = await setupGitVault(vault, bareDir);

    server = await startServer({ vault, mode: 'full' });
    await enableAutoSync(server.baseUrl, bareUrl);
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
    await cleanupVault(bareDir).catch(() => { /* ignore */ });
  });

  it('[AC-Se29635-3-1] POST /api/sync/flush が 200 で SyncStatus を返す', async () => {
    // ノートを作成してから即座に flush を呼ぶ (debounce より早く)
    const noteRes = await fetch(`${server.baseUrl}/api/notes/notes/flush-test.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# flush test\n\nShould be pushed via flush.\n' }),
    });
    expect([200, 201]).toContain(noteRes.status);

    // flush を呼ぶ (debounce が pending なら即時実行される)
    const flushRes = await fetch(`${server.baseUrl}/api/sync/flush`, { method: 'POST' });
    expect(flushRes.status).toBe(200);
    const flushBody = (await flushRes.json()) as Record<string, unknown>;
    // SyncStatus のフィールドが含まれることを確認する
    expect(typeof flushBody.available).toBe('boolean');
    expect(typeof flushBody.offline).toBe('boolean');

    // flush 後は bare に flush-test.md が現れるまでポーリングする
    const appeared = await pollUntil(() => {
      try {
        const ls = execSync(
          `git --git-dir="${bareDir}" ls-tree -r --name-only main`,
          { encoding: 'utf8' },
        );
        return ls.includes('notes/flush-test.md');
      } catch {
        return false;
      }
    }, 10_000);
    expect(appeared).toBe(true);
  });
});
