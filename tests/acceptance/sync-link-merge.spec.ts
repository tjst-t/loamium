/**
 * 受け入れテスト: 両側データありの安全マージ (Sf17a4c-2)。
 *
 * 実 system git + file:// bare リポジトリ使用。モックなし。
 * InitialLinker.previewMerge / applyMerge を直接テストする。
 *
 * [AC-Sf17a4c-2-1] merge-tree プレビューが作業ツリーを一切汚さない
 * [AC-Sf17a4c-2-2] keep-both/local/remote/merge の解決指定が正しく適用される。
 *                  stage mapping: :2:=ローカル / :3:=リモート
 * [AC-Sf17a4c-2-3] push 後に別クローンで両側の元データが保持されることを確認 (データ喪失ゼロ)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type ConflictResolution,
  InitialLinker,
} from '../../packages/server/src/sync/link.js';
import { SystemGitRunner } from '../../packages/server/src/sync/git-runner.js';

// ──────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────

/** git コマンドを同期実行 (テスト setup 用) */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

/** 一時ディレクトリを作成する */
async function makeTempDir(prefix = 'loamium-test-'): Promise<string> {
  const base = path.join(
    os.tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}

/** ディレクトリを安全に削除する */
async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** ダミー audit コールバック */
const noop = async () => { /* no-op */ };

/**
 * 空の bare リポジトリを作成し file:// URL を返す。
 */
async function makeEmptyBare(): Promise<{ bareDir: string; bareUrl: string }> {
  const bareDir = await makeTempDir('loamium-bare-');
  git('init --bare', bareDir);
  git('symbolic-ref HEAD refs/heads/main', bareDir);
  return { bareDir, bareUrl: `file://${bareDir}` };
}

/**
 * AC-Sf17a4c-2 のメインシナリオ用セットアップ。
 *
 * ローカル vault: A.md, B.md, メモ/買い物.md (牛乳/卵)
 * リモート bare:  C.md, メモ/買い物.md (牛乳/パン) — 別クローンで push 済み
 */
async function setupBothSides(): Promise<{
  vaultDir: string;
  bareDir: string;
  bareUrl: string;
  cloneDir: string;
}> {
  // 空 bare を作成
  const { bareDir, bareUrl } = await makeEmptyBare();

  // リモート側: bare に clone → C.md + メモ/買い物.md(リモート版) を push
  const cloneDir = await makeTempDir('loamium-remote-clone-');
  git(`clone ${bareUrl} .`, cloneDir);
  git('config user.email test@test.local', cloneDir);
  git('config user.name Test', cloneDir);
  // C.md
  await writeFile(path.join(cloneDir, 'C.md'), '# C\n\nRemote only file.\n', 'utf8');
  // メモ/買い物.md (リモート版: 牛乳/パン)
  await mkdir(path.join(cloneDir, 'メモ'), { recursive: true });
  await writeFile(
    path.join(cloneDir, 'メモ', '買い物.md'),
    '# 買い物リスト\n\n- 牛乳\n- パン\n',
    'utf8',
  );
  git('add -A', cloneDir);
  git('commit -m "remote: add C.md and メモ/買い物.md"', cloneDir);
  git('push origin main', cloneDir);

  // ローカル vault を git 化
  const vaultDir = await makeTempDir('loamium-vault-');
  git('init -b main', vaultDir);
  git('config user.email test@test.local', vaultDir);
  git('config user.name Test', vaultDir);
  // A.md, B.md (ローカルのみ)
  await writeFile(path.join(vaultDir, 'A.md'), '# A\n\nLocal only file A.\n', 'utf8');
  await writeFile(path.join(vaultDir, 'B.md'), '# B\n\nLocal only file B.\n', 'utf8');
  // メモ/買い物.md (ローカル版: 牛乳/卵)
  await mkdir(path.join(vaultDir, 'メモ'), { recursive: true });
  await writeFile(
    path.join(vaultDir, 'メモ', '買い物.md'),
    '# 買い物リスト\n\n- 牛乳\n- 卵\n',
    'utf8',
  );
  git('add -A', vaultDir);
  git('commit -m "local: add A.md, B.md, メモ/買い物.md"', vaultDir);

  return { vaultDir, bareDir, bareUrl, cloneDir };
}

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-1: merge-tree プレビュー (作業ツリー未変更)
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-1] previewMerge: 作業ツリーを触らずマージ件数を算出', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
  });

  it('previewMerge が件数と衝突ファイル一覧を返す', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });

    // リモートを fetch しておく必要がある (merge-tree は両 ref が git db にある必要)
    git(`remote add origin ${bareUrl}`, vaultDir);
    git('fetch origin main', vaultDir);

    const preview = await linker.previewMerge('HEAD', 'origin/main');

    // C.md はリモートのみ → addedFromRemote に含まれる
    expect(preview.addedFromRemote).toBeGreaterThanOrEqual(1);

    // A.md, B.md はローカルのみ → addedFromLocal に含まれる
    expect(preview.addedFromLocal).toBeGreaterThanOrEqual(2);

    // メモ/買い物.md は同名別内容 → conflicts に含まれる
    expect(preview.conflicts.length).toBeGreaterThanOrEqual(1);
    const conflictFiles = preview.conflicts.map((c) => c.file);
    expect(conflictFiles).toContain('メモ/買い物.md');

    // 3-way 統合 UI 用に ours(local)/theirs(remote) のテキスト内容が付く
    const shopping = preview.conflicts.find((c) => c.file === 'メモ/買い物.md');
    expect(shopping?.ours).toContain('卵'); // ローカル内容
    expect(shopping?.theirs).toContain('パン'); // リモート内容

    // isClean は false (衝突があるから)
    expect(preview.isClean).toBe(false);
  });

  it('previewMerge 後に作業ツリーがクリーンのまま', () => {
    // git status --porcelain が空文字列 = 作業ツリー未変更
    const status = git('status --porcelain', vaultDir);
    expect(status).toBe('');
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-2: keep-both で解決
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-2] applyMerge: keep-both 解決 (stage mapping :2:=local, :3:=remote)', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
  });

  it('keep-both: ローカル内容が元のパスに残り、リモート内容が .remote.md に書かれる', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });

    const resolutions: ConflictResolution[] = [
      { file: 'メモ/買い物.md', action: 'keep-both' },
    ];

    const result = await linker.applyMerge(bareUrl, 'main', resolutions);
    expect(result.ok).toBe(true);
    expect(result.needsMerge).toBe(false);

    // ローカルの元パス: ローカル内容 (牛乳/卵)
    const localContent = await readFile(
      path.join(vaultDir, 'メモ', '買い物.md'),
      'utf8',
    );
    expect(localContent).toContain('卵');
    expect(localContent).not.toContain('パン');

    // リモート版が .remote.md として保存されている
    const remoteContent = await readFile(
      path.join(vaultDir, 'メモ', '買い物.remote.md'),
      'utf8',
    );
    expect(remoteContent).toContain('パン');
    expect(remoteContent).not.toContain('卵');

    // 片側のみのファイルが両立している
    const aContent = await readFile(path.join(vaultDir, 'A.md'), 'utf8');
    expect(aContent).toContain('Local only file A');

    const bContent = await readFile(path.join(vaultDir, 'B.md'), 'utf8');
    expect(bContent).toContain('Local only file B');

    const cContent = await readFile(path.join(vaultDir, 'C.md'), 'utf8');
    expect(cContent).toContain('Remote only file');
  });

  it('stage mapping 確認: :2:=local のためローカル版が元のパスに残っている', async () => {
    // ローカル版 (牛乳/卵) が元のパスに入っていることを確認 (stage :2: = local)
    const content = await readFile(path.join(vaultDir, 'メモ', '買い物.md'), 'utf8');
    // ローカル版には「卵」が含まれ「パン」は含まれない
    expect(content).toContain('卵');
    expect(content).not.toContain('パン');
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-2: local 解決
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-2] applyMerge: local 解決 (ローカル採用)', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
  });

  it('local 解決: ローカル版のみが元のパスに残る', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });

    const resolutions: ConflictResolution[] = [
      { file: 'メモ/買い物.md', action: 'local' },
    ];

    const result = await linker.applyMerge(bareUrl, 'main', resolutions);
    expect(result.ok).toBe(true);

    // ローカル版が元のパスに
    const content = await readFile(path.join(vaultDir, 'メモ', '買い物.md'), 'utf8');
    expect(content).toContain('卵');
    expect(content).not.toContain('パン');

    // .remote.md は存在しない
    let remoteExists = false;
    try {
      await readFile(path.join(vaultDir, 'メモ', '買い物.remote.md'), 'utf8');
      remoteExists = true;
    } catch {
      remoteExists = false;
    }
    expect(remoteExists).toBe(false);

    // backup ref が作成されているので外した側も復元可能
    const branches = git('branch', vaultDir);
    expect(branches).toMatch(/backup\/pre-link-/);
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-2: remote 解決
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-2] applyMerge: remote 解決 (リモート採用)', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
  });

  it('remote 解決: リモート版が元のパスに書かれる', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });

    const resolutions: ConflictResolution[] = [
      { file: 'メモ/買い物.md', action: 'remote' },
    ];

    const result = await linker.applyMerge(bareUrl, 'main', resolutions);
    expect(result.ok).toBe(true);

    // リモート版 (パン) が元のパスに
    const content = await readFile(path.join(vaultDir, 'メモ', '買い物.md'), 'utf8');
    expect(content).toContain('パン');
    expect(content).not.toContain('卵');
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-2: merge (3-way テキスト提供) 解決
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-2] applyMerge: merge 解決 (mergedText を書き込む)', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
  });

  it('merge 解決: 提供された mergedText が元のパスに書かれる', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });

    const mergedText = '# 買い物リスト\n\n- 牛乳\n- 卵\n- パン\n';
    const resolutions: ConflictResolution[] = [
      { file: 'メモ/買い物.md', action: 'merge', mergedText },
    ];

    const result = await linker.applyMerge(bareUrl, 'main', resolutions);
    expect(result.ok).toBe(true);

    const content = await readFile(path.join(vaultDir, 'メモ', '買い物.md'), 'utf8');
    expect(content).toContain('卵');
    expect(content).toContain('パン');
    expect(content).toContain('牛乳');
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-3: push 後に別クローンでデータ喪失ゼロを確認
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-3] データ喪失ゼロ: push 後に別クローンで両側データを確認', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  let verifyCloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
    verifyCloneDir = await makeTempDir('loamium-verify-clone-');
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
    await removeDir(verifyCloneDir);
  });

  it('keep-both で push 後、別クローンで両側のファイルが存在する (byte 一致)', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });

    // keep-both で apply + push
    const resolutions: ConflictResolution[] = [
      { file: 'メモ/買い物.md', action: 'keep-both' },
    ];
    const result = await linker.applyMerge(bareUrl, 'main', resolutions);
    expect(result.ok).toBe(true);

    // 別クローンで bare を clone して確認
    git(`clone ${bareUrl} .`, verifyCloneDir);

    // ローカル版 (買い物.md = 牛乳/卵) が存在
    const localContent = await readFile(
      path.join(verifyCloneDir, 'メモ', '買い物.md'),
      'utf8',
    );
    expect(localContent).toContain('卵');
    expect(localContent).not.toContain('パン');

    // リモート版 (買い物.remote.md = 牛乳/パン) が存在
    const remoteContent = await readFile(
      path.join(verifyCloneDir, 'メモ', '買い物.remote.md'),
      'utf8',
    );
    expect(remoteContent).toContain('パン');
    expect(remoteContent).not.toContain('卵');

    // A.md, B.md (ローカルのみ) が存在
    const aContent = await readFile(path.join(verifyCloneDir, 'A.md'), 'utf8');
    expect(aContent).toContain('Local only file A');
    const bContent = await readFile(path.join(verifyCloneDir, 'B.md'), 'utf8');
    expect(bContent).toContain('Local only file B');

    // C.md (リモートのみ) が存在
    const cContent = await readFile(path.join(verifyCloneDir, 'C.md'), 'utf8');
    expect(cContent).toContain('Remote only file');
  });

  it('backup/pre-link-* ref が存在する', () => {
    // ローカル vault に backup ref があることを確認
    const branches = git('branch', vaultDir);
    expect(branches).toMatch(/backup\/pre-link-/);
  });

  it('byte-exact: 元のローカルとクローン内の buy-list が一致する', async () => {
    // vaultDir の買い物.md とクローンの買い物.md が同一内容
    // (vaultDir は push 後なので同じものが bare に入っているはず)
    const vaultLocal = await readFile(
      path.join(vaultDir, 'メモ', '買い物.md'),
      'utf8',
    );
    const cloneLocal = await readFile(
      path.join(verifyCloneDir, 'メモ', '買い物.md'),
      'utf8',
    );
    expect(vaultLocal).toBe(cloneLocal);

    const vaultRemote = await readFile(
      path.join(vaultDir, 'メモ', '買い物.remote.md'),
      'utf8',
    );
    const cloneRemote = await readFile(
      path.join(verifyCloneDir, 'メモ', '買い物.remote.md'),
      'utf8',
    );
    expect(vaultRemote).toBe(cloneRemote);
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-2-2: merge の mergedText 欠落は keep-both に安全フォールバック (review F-1)
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-2-2] applyMerge: merge の mergedText が空なら keep-both に安全フォールバック', () => {
  let vaultDir: string;
  let bareDir: string;
  let bareUrl: string;
  let cloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    ({ vaultDir, bareDir, bareUrl, cloneDir } = await setupBothSides());
  });
  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(bareDir);
    await removeDir(cloneDir);
  });

  it('merge かつ mergedText="" → 空ファイルで上書きせず両方保持 (データ喪失ゼロ)', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
    // REST 経由の不正入力を模擬: action=merge だが mergedText 空
    const resolutions: ConflictResolution[] = [
      { file: 'メモ/買い物.md', action: 'merge', mergedText: '' },
    ];
    const result = await linker.applyMerge(bareUrl, 'main', resolutions);
    expect(result.ok).toBe(true);

    // 元パスは空でなくローカル版 (卵) が残っている
    const localContent = await readFile(path.join(vaultDir, 'メモ', '買い物.md'), 'utf8');
    expect(localContent.trim()).not.toBe('');
    expect(localContent).toContain('卵');
    // リモート版も .remote.md として保持されている
    const remoteContent = await readFile(path.join(vaultDir, 'メモ', '買い物.remote.md'), 'utf8');
    expect(remoteContent).toContain('パン');
  });
});
