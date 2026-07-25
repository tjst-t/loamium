/**
 * 受け入れテスト: Vault 同期リモート設定・認証委譲・手動同期・起動時 pull (Se29635-2)。
 *
 * test-discipline Rule 7: 実 system git + ローカル bare リポジトリ (file://)。mock 禁止。
 * test-discipline Rule 8 精神: 往復バイト一致検証を含む。
 *
 * [AC-Se29635-2-1] ハブは任意の git リモートを設定で差し替えできる
 * [AC-Se29635-2-2] 認証は git credential 機構へ委譲。フォールバック PAT は 0600 に保管
 * [AC-Se29635-2-3] 手動「今すぐ同期」と起動時 pull が動作し index が追従する
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync, exec } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

const execAsync = promisify(exec);

// ──────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────

/** git コマンドを同期実行 (テスト setup 用) */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

/**
 * vault を git init し bare リポジトリを作成する。
 * vault の初期コミットを bare に push して bare に `main` ブランチを確立する。
 * - `vaultDir`: 作業 vault
 * - `bareDir`: bare repo のパス
 * 戻り値: `file://` URL
 */
async function setupGitVault(vaultDir: string, bareDir: string): Promise<string> {
  // 1. vault を git init + user 設定 + 初期コミット
  git('init', vaultDir);
  // git のデフォルトブランチが master の環境でも main に統一する
  git('branch -m master main', vaultDir);
  git('config user.email test@test.local', vaultDir);
  git('config user.name Test', vaultDir);

  // .gitignore を追加: .loamium/ はサーバーが audit.log 等を書くが git 管理外
  // (pull --rebase 時に「unstaged changes」で失敗しないよう gitignore 必須)
  await writeFile(path.join(vaultDir, '.gitignore'), '.loamium/\n', 'utf8');
  git('add .gitignore', vaultDir);
  git('commit -m "init: add .gitignore"', vaultDir);

  // 2. bare リポジトリ作成 + HEAD を main に設定
  await mkdir(bareDir, { recursive: true });
  git('init --bare', bareDir);
  // bare の HEAD を main に設定しないとクローン時にデフォルトブランチが master になる
  git('symbolic-ref HEAD refs/heads/main', bareDir);

  const bareUrl = `file://${bareDir}`;

  // 3. vault の初期コミットを bare に push して main ブランチを確立する
  //    (bare が空のままだとクローン時に "main" ref が無く pushFromClone が失敗する)
  git(`remote add origin ${bareUrl}`, vaultDir);
  git('push origin main', vaultDir);

  return bareUrl;
}

/**
 * 第二クローン (端末B相当) を作成し、`notes/from-b.md` を bare に push する。
 */
async function pushFromClone(bareUrl: string, cloneDir: string): Promise<void> {
  await mkdir(cloneDir, { recursive: true });
  git(`clone ${bareUrl} .`, cloneDir);
  // bare の HEAD が不整合な場合に備えて main を明示的にチェックアウト
  git('checkout main', cloneDir);
  git('config user.email test@test.local', cloneDir);
  git('config user.name Test', cloneDir);

  // notes/ ディレクトリ + ファイル作成
  await mkdir(path.join(cloneDir, 'notes'), { recursive: true });
  await writeFile(
    path.join(cloneDir, 'notes', 'from-b.md'),
    '# from-b\n\nThis is from terminal B.\n',
    'utf8',
  );
  git('add -A', cloneDir);
  git('commit -m "add from-b.md"', cloneDir);
  git('push origin main', cloneDir);
}

// ──────────────────────────────────────────────
// Scenario 1 — [AC-Se29635-2-1] + [AC-Se29635-2-3]
// ──────────────────────────────────────────────

describe('Scenario 1: git リモート設定 + 手動同期 + pull インデックス追従', () => {
  let vault: string;
  let bareDir: string;
  let cloneDir: string;
  let bareUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    bareDir = `${vault}-hub.git`;
    cloneDir = `${vault}-clone-b`;
    bareUrl = await setupGitVault(vault, bareDir);

    // サーバー起動 (同期設定なし状態)
    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
    await cleanupVault(bareDir).catch(() => { /* ignore */ });
    await cleanupVault(cloneDir).catch(() => { /* ignore */ });
  });

  it('[AC-Se29635-2-1] PUT /api/sync/config で remoteUrl を設定でき GET で取得できる', async () => {
    const res = await fetch(`${server.baseUrl}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remoteUrl: bareUrl,
        branch: 'main',
        enabled: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.remoteUrl).toBe(bareUrl);
    expect(body.enabled).toBe(true);

    // GET でも返ってくることを確認
    const getRes = await fetch(`${server.baseUrl}/api/sync/config`);
    expect(getRes.status).toBe(200);
    const getCfg = (await getRes.json()) as Record<string, unknown>;
    expect(getCfg.remoteUrl).toBe(bareUrl);
  });

  it('[AC-Se29635-2-3] vault にノートを作成し POST /api/sync/now で push できる', async () => {
    // ノートを作成
    const noteRes = await fetch(`${server.baseUrl}/api/notes/notes/from-a.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# from-a\n\nContent from terminal A.\n' }),
    });
    // 新規ノート作成は 201、既存の場合は 200
    expect([200, 201]).toContain(noteRes.status);

    // 今すぐ同期
    const syncRes = await fetch(`${server.baseUrl}/api/sync/now`, { method: 'POST' });
    expect(syncRes.status).toBe(200);
    const syncBody = (await syncRes.json()) as Record<string, unknown>;
    expect(syncBody.ok).toBe(true);
    expect(syncBody.pushed).toBe(true);

    // bare リポジトリの main tip に from-a.md が含まれることを確認 (実 push)
    const lsResult = execSync(
      `git --git-dir="${bareDir}" ls-tree -r --name-only main`,
      { encoding: 'utf8' },
    );
    expect(lsResult).toContain('notes/from-a.md');
  });

  it('[AC-Se29635-2-3] 端末B から push された変更を POST /api/sync/pull で取り込み index に反映される', async () => {
    // 端末B相当: bare に from-b.md を push
    await pushFromClone(bareUrl, cloneDir);

    // 手動 pull
    const pullRes = await fetch(`${server.baseUrl}/api/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual-test' }),
    });
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as Record<string, unknown>;
    expect(pullBody.ok).toBe(true);

    // vault に from-b.md が実体で存在することを確認
    const fromBPath = path.join(vault, 'notes', 'from-b.md');
    const fromBContent = await readFile(fromBPath, 'utf8');
    expect(fromBContent).toContain('from-b');

    // watcher/インデックス追従: API search または notes 一覧に出ること
    // index 追従は watcher が非同期のため少し待つ
    await new Promise<void>((r) => setTimeout(r, 500));
    const searchRes = await fetch(`${server.baseUrl}/api/notes?q=from-b`);
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as Record<string, unknown>;
    const notes = searchBody.notes as Array<Record<string, unknown>>;
    expect(notes.some((n) => String(n.path ?? '').includes('from-b'))).toBe(true);
  });

  it('[AC-Se29635-2-3] from-a.md の内容が端末B クローンと一致する (往復バイト一致)', async () => {
    // vault の from-a.md を読む
    const vaultContent = await readFile(path.join(vault, 'notes', 'from-a.md'), 'utf8');

    // 端末B クローンで pull して from-a.md を読む (--rebase で diverge を回避)
    await execAsync('git pull --rebase origin main', { cwd: cloneDir });
    const cloneContent = await readFile(path.join(cloneDir, 'notes', 'from-a.md'), 'utf8');

    expect(vaultContent).toBe(cloneContent);
  });
});

// ──────────────────────────────────────────────
// Scenario 2 — [AC-Se29635-2-2] 認証委譲・0600 保管
// ──────────────────────────────────────────────

describe('Scenario 2: PAT は .loamium 0600 に保管し vault 管理下には保存しない', () => {
  let vault: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    // git init (token 検証のために vault が git repo である必要がある)
    git('init', vault);
    git('branch -m master main', vault);
    git('config user.email test@test.local', vault);
    git('config user.name Test', vault);
    await writeFile(path.join(vault, '.gitignore'), '.loamium/\n', 'utf8');
    git('add .gitignore', vault);
    git('commit -m "init: add .gitignore"', vault);

    server = await startServer({ vault, mode: 'full' });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
  });

  it('[AC-Se29635-2-2] PUT /api/sync/credential でトークンを保存 → .loamium/sync-credentials.json が mode 0600 で作成される', async () => {
    const res = await fetch(`${server.baseUrl}/api/sync/credential`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_dummyXXXX' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // .loamium/sync-credentials.json が 0600 で作成されていること
    const credPath = path.join(vault, '.loamium', 'sync-credentials.json');
    const info = await stat(credPath);
    // Unix: mode & 0o777 === 0o600
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('[AC-Se29635-2-2] vault の git 追跡ファイルにトークンが含まれない', async () => {
    // git ls-files で追跡ファイルを列挙し、その内容にトークンが含まれないことを確認
    const tracked = execSync(`git ls-files`, { cwd: vault, encoding: 'utf8' }).trim();
    const TOKEN = 'ghp_dummyXXXX';

    if (tracked !== '') {
      for (const relPath of tracked.split('\n')) {
        const absPath = path.join(vault, relPath.trim());
        let content: string;
        try {
          content = await readFile(absPath, 'utf8');
        } catch {
          continue; // 読めないファイルはスキップ
        }
        expect(content).not.toContain(TOKEN);
      }
    }
  });

  it('[AC-Se29635-2-2] .git/config にトークンが含まれない', async () => {
    const gitConfigPath = path.join(vault, '.git', 'config');
    const content = await readFile(gitConfigPath, 'utf8');
    expect(content).not.toContain('ghp_dummyXXXX');
  });

  it('[AC-Se29635-2-2] GET /api/sync/config でトークンが redact されている (実値を返さない)', async () => {
    const res = await fetch(`${server.baseUrl}/api/sync/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // token フィールドは存在しない
    expect(body).not.toHaveProperty('token');
    // tokenConfigured フラグのみ返る
    expect(body.tokenConfigured).toBe(true);

    // レスポンスのテキスト表現にもトークン実値が含まれないことを確認
    const responseText = JSON.stringify(body);
    expect(responseText).not.toContain('ghp_dummyXXXX');
  });
});

// ──────────────────────────────────────────────
// Scenario 3 — 起動時 pull (AC-Se29635-2-3 startup pull)
// ──────────────────────────────────────────────

describe('Scenario 3: 起動時 pull で降った変更をインデックスが追従する', () => {
  let vault: string;
  let bareDir: string;
  let cloneDir: string;
  let bareUrl: string;

  beforeAll(async () => {
    vault = await makeTempVault();
    bareDir = `${vault}-hub2.git`;
    cloneDir = `${vault}-clone-c`;
    bareUrl = await setupGitVault(vault, bareDir);
  });

  afterAll(async () => {
    await cleanupVault(vault);
    await cleanupVault(bareDir).catch(() => { /* ignore */ });
    await cleanupVault(cloneDir).catch(() => { /* ignore */ });
  });

  it('[AC-Se29635-2-3] 起動前に bare へ push された変更が、起動時 pull で vault に降り index に反映される', async () => {
    // sync.json を事前書き込み (enabled:true + remoteUrl 設定済み状態でサーバーを起動する)
    await mkdir(path.join(vault, '.loamium'), { recursive: true });
    await writeFile(
      path.join(vault, '.loamium', 'sync.json'),
      JSON.stringify({
        enabled: true,
        remoteUrl: bareUrl,
        branch: 'main',
        remoteName: 'origin',
        autoSync: false,
        debounceMs: 30000,
        pullIntervalMs: 900000,
        deviceName: 'test-device',
      }),
      'utf8',
    );

    // setupGitVault が vault に origin を追加済みのため、ここでは追加しない

    // 端末C (cloneDir) から from-startup.md を bare に push
    await pushFromCloneWithFile(bareUrl, cloneDir, 'notes/from-startup.md', '# from-startup\n\nAdded before server boot.\n');

    // サーバーを起動 → 起動時 pull が走るはず
    const server = await startServer({ vault, mode: 'full' });

    try {
      // 少し待機して startup pull 完了を待つ
      await new Promise<void>((r) => setTimeout(r, 1000));

      // vault に from-startup.md が存在することを確認
      const content = await readFile(path.join(vault, 'notes', 'from-startup.md'), 'utf8');
      expect(content).toContain('from-startup');

      // インデックスに反映されているか (watcher 経由)
      await new Promise<void>((r) => setTimeout(r, 500));
      const searchRes = await fetch(`${server.baseUrl}/api/notes?q=from-startup`);
      expect(searchRes.status).toBe(200);
      const searchBody = (await searchRes.json()) as Record<string, unknown>;
      const notes = searchBody.notes as Array<Record<string, unknown>>;
      expect(notes.some((n) => String(n.path ?? '').includes('from-startup'))).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

// ──────────────────────────────────────────────
// 追加ヘルパー
// ──────────────────────────────────────────────

/** 指定ファイルを bare に push するクローンヘルパー (汎用) */
async function pushFromCloneWithFile(
  bareUrl: string,
  cloneDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  await mkdir(cloneDir, { recursive: true });
  git(`clone ${bareUrl} .`, cloneDir);
  // bare の HEAD が不整合な場合に備えて main を明示的にチェックアウト
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
