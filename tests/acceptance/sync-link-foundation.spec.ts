/**
 * 受け入れテスト: 初回リンク基盤 (Sf17a4c-1)。
 *
 * 実 system git + file:// bare リポジトリを使用。モックなし。
 * link.ts の InitialLinker を直接テストする (HTTP は Story 4 まで未接続)。
 *
 * [AC-Sf17a4c-1-1] auto-init: 非 git vault を git 化し、既存データを1コミットに固める。ネスト拒否。
 * [AC-Sf17a4c-1-2] ls-remote 3判別: 空/非空/到達不能を正しく判別し到達不能を空と誤認しない。
 * [AC-Sf17a4c-1-3] 空×空/空×非空/非空×空 の分岐。backup ref。非空×非空 → needsMerge=true。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InitialLinker } from '../../packages/server/src/sync/link.js';
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
  const base = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
 * HEAD は main を指す。
 */
async function makeEmptyBare(): Promise<{ bareDir: string; bareUrl: string }> {
  const bareDir = await makeTempDir('loamium-bare-');
  git('init --bare', bareDir);
  git('symbolic-ref HEAD refs/heads/main', bareDir);
  return { bareDir, bareUrl: `file://${bareDir}` };
}

/**
 * 非空の bare リポジトリを作成し file:// URL を返す。
 * clone → ファイル追加 → push で main ブランチを確立する。
 */
async function makeNonEmptyBare(fileName = 'remote-note.md'): Promise<{ bareDir: string; bareUrl: string; cloneDir: string }> {
  const bareDir = await makeTempDir('loamium-bare-');
  git('init --bare', bareDir);
  git('symbolic-ref HEAD refs/heads/main', bareDir);
  const bareUrl = `file://${bareDir}`;

  // clone → ファイル追加 → push
  const cloneDir = await makeTempDir('loamium-clone-');
  git(`clone ${bareUrl} .`, cloneDir);
  git('config user.email test@test.local', cloneDir);
  git('config user.name Test', cloneDir);
  await writeFile(path.join(cloneDir, fileName), `# ${fileName}\n\nContent from remote.\n`, 'utf8');
  git('add -A', cloneDir);
  git(`commit -m "add ${fileName}"`, cloneDir);
  git('push origin main', cloneDir);

  return { bareDir, bareUrl, cloneDir };
}

// ──────────────────────────────────────────────
// AC-Sf17a4c-1-1: auto-init
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-1-1] auto-init: 非 git vault を初期化し1スナップショットコミットを作る', () => {
  let vaultDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    vaultDir = await makeTempDir('loamium-vault-');
    // 非 git vault にノートを2本置く
    await writeFile(path.join(vaultDir, 'note-a.md'), '# Note A\n\nHello.\n', 'utf8');
    await writeFile(path.join(vaultDir, 'note-b.md'), '# Note B\n\nWorld.\n', 'utf8');
  });

  afterAll(async () => {
    await removeDir(vaultDir);
  });

  it('ensureInitialized() で vault が git repo になり HEAD が存在する', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
    await linker.ensureInitialized();

    // git rev-parse HEAD が成功する
    const head = git('rev-parse HEAD', vaultDir);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('.gitignore に .loamium/ が含まれる', async () => {
    const content = await readFile(path.join(vaultDir, '.gitignore'), 'utf8');
    expect(content).toContain('.loamium/');
  });

  it('.gitattributes に eol=lf が含まれる', async () => {
    const content = await readFile(path.join(vaultDir, '.gitattributes'), 'utf8');
    expect(content).toContain('eol=lf');
  });

  it('ノートが1つのコミットに含まれる', async () => {
    const logCount = git('rev-list --count HEAD', vaultDir);
    expect(parseInt(logCount, 10)).toBeGreaterThanOrEqual(1);

    const lsTree = git('ls-tree -r --name-only HEAD', vaultDir);
    expect(lsTree).toContain('note-a.md');
    expect(lsTree).toContain('note-b.md');
  });

  it('冪等: 2回目の ensureInitialized() は何もしない', async () => {
    const headBefore = git('rev-parse HEAD', vaultDir);
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
    await linker.ensureInitialized(); // 2回目
    const headAfter = git('rev-parse HEAD', vaultDir);
    expect(headBefore).toBe(headAfter);
  });

  it('ネストケース: vault が親 git リポジトリの内側にある場合に throw する', async () => {
    // 親 repo を作成
    const parentDir = await makeTempDir('loamium-parent-');
    git('init', parentDir);
    git('config user.email test@test.local', parentDir);
    git('config user.name Test', parentDir);
    await writeFile(path.join(parentDir, 'parent.md'), '# parent\n', 'utf8');
    git('add -A', parentDir);
    git('commit -m "init parent"', parentDir);

    // 親の内側に非 git vault を作成
    const nestedVault = path.join(parentDir, 'nested-vault');
    await mkdir(nestedVault);
    await writeFile(path.join(nestedVault, 'note.md'), '# note\n', 'utf8');

    const linker = new InitialLinker({ vaultRoot: nestedVault, runner, audit: noop });

    // ネスト拒否 → throw
    await expect(linker.ensureInitialized()).rejects.toThrow(/ネスト/);

    // 親リポジトリの HEAD は変更されていない
    const parentHead = git('rev-parse HEAD', parentDir);
    expect(parentHead).toMatch(/^[0-9a-f]{40}$/);

    await removeDir(parentDir);
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-1-2: ls-remote 3判別
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-1-2] probeRemote: 空/非空/到達不能を3択で判別する', () => {
  let vaultDir: string;
  let emptyBareDir: string;
  let nonEmptyBareDir: string;
  let nonEmptyCloneDir: string;
  const runner = new SystemGitRunner();

  beforeAll(async () => {
    vaultDir = await makeTempDir('loamium-vault-');
    // vault を git init しておく (probeRemote は cwd 指定で実行するため)
    git('init', vaultDir);
    git('config user.email test@test.local', vaultDir);
    git('config user.name Test', vaultDir);

    const empty = await makeEmptyBare();
    emptyBareDir = empty.bareDir;

    const nonEmpty = await makeNonEmptyBare();
    nonEmptyBareDir = nonEmpty.bareDir;
    nonEmptyCloneDir = nonEmpty.cloneDir;
  });

  afterAll(async () => {
    await removeDir(vaultDir);
    await removeDir(emptyBareDir);
    await removeDir(nonEmptyBareDir);
    await removeDir(nonEmptyCloneDir).catch(() => { /* ignore */ });
  });

  it('空 bare を probe → empty', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
    const result = await linker.probeRemote(`file://${emptyBareDir}`);
    expect(result.state).toBe('empty');
    expect(result.defaultBranch).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('非空 bare を probe → non-empty (defaultBranch=main)', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
    const result = await linker.probeRemote(`file://${nonEmptyBareDir}`);
    expect(result.state).toBe('non-empty');
    expect(result.defaultBranch).toBe('main');
    expect(result.error).toBeUndefined();
  });

  it('到達不能 URL を probe → unreachable (空と誤認しない)', async () => {
    const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
    const result = await linker.probeRemote('file:///nonexistent-path-that-cannot-exist-xyz');
    expect(result.state).toBe('unreachable');
    expect(result.defaultBranch).toBeNull();
    // error フィールドが設定されている
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
  });
});

// ──────────────────────────────────────────────
// AC-Sf17a4c-1-3: 空×空/空×非空/非空×空 分岐 + backup ref + needsMerge
// ──────────────────────────────────────────────

describe('[AC-Sf17a4c-1-3] linkEmptyOrOneSided: 3ケースの分岐と backup ref', () => {
  const runner = new SystemGitRunner();

  // ── ケース1: [ローカル非空 × リモート空] push でリモートを種付け ──

  describe('ケース1: ローカル非空 × リモート空 → push してリモートを種付け', () => {
    let vaultDir: string;
    let bareDir: string;

    beforeAll(async () => {
      vaultDir = await makeTempDir('loamium-vault-');
      // vault を git init + 1コミット (ローカル非空)
      git('init -b main', vaultDir);
      git('config user.email test@test.local', vaultDir);
      git('config user.name Test', vaultDir);
      await writeFile(path.join(vaultDir, 'my-note.md'), '# My Note\n\nLocal content.\n', 'utf8');
      git('add -A', vaultDir);
      git('commit -m "add my-note.md"', vaultDir);

      // 空 bare を作成 (リモート空)
      const empty = await makeEmptyBare();
      bareDir = empty.bareDir;
    });

    afterAll(async () => {
      await removeDir(vaultDir);
      await removeDir(bareDir);
    });

    it('linkEmptyOrOneSided → ok=true, needsMerge=false', async () => {
      const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
      const result = await linker.linkEmptyOrOneSided(`file://${bareDir}`, 'main');
      expect(result.ok).toBe(true);
      expect(result.needsMerge).toBe(false);
    });

    it('bare に my-note.md が push されている', () => {
      const lsTree = git(`--git-dir="${bareDir}" ls-tree -r --name-only main`, vaultDir);
      expect(lsTree).toContain('my-note.md');
    });

    it('backup/pre-link-* ref が作成されている', () => {
      // linkEmptyOrOneSided 内で backup ref を作成している
      const branches = git('branch', vaultDir);
      expect(branches).toMatch(/backup\/pre-link-/);
    });
  });

  // ── ケース2: [ローカル空 × リモート非空] fetch→checkout でリモートを採用 ──

  describe('ケース2: ローカル空 × リモート非空 → checkout でリモート内容を採用', () => {
    let vaultDir: string;
    let bareDir: string;
    let cloneDir: string;

    beforeAll(async () => {
      vaultDir = await makeTempDir('loamium-vault-');
      // vault は非 git (ローカル空状態にするため ensureInitialized は呼ばない)
      // git init だけして commit は作らない → ローカル空
      git('init -b main', vaultDir);
      git('config user.email test@test.local', vaultDir);
      git('config user.name Test', vaultDir);

      // 非空 bare を作成
      const nonEmpty = await makeNonEmptyBare('remote-note.md');
      bareDir = nonEmpty.bareDir;
      cloneDir = nonEmpty.cloneDir;
    });

    afterAll(async () => {
      await removeDir(vaultDir);
      await removeDir(bareDir);
      await removeDir(cloneDir).catch(() => { /* ignore */ });
    });

    it('linkEmptyOrOneSided → ok=true, needsMerge=false', async () => {
      const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
      const result = await linker.linkEmptyOrOneSided(`file://${bareDir}`, 'main');
      expect(result.ok).toBe(true);
      expect(result.needsMerge).toBe(false);
    });

    it('vault に remote-note.md が出現している', async () => {
      const content = await readFile(path.join(vaultDir, 'remote-note.md'), 'utf8');
      expect(content).toContain('Content from remote.');
    });
  });

  // ── ケース3: [ローカル非空 × リモート非空] → needsMerge=true + backup ref ──

  describe('ケース3: ローカル非空 × リモート非空 → needsMerge=true (マージ未実施)', () => {
    let vaultDir: string;
    let bareDir: string;
    let cloneDir: string;

    beforeAll(async () => {
      vaultDir = await makeTempDir('loamium-vault-');
      // vault: git init + 1コミット (ローカル非空)
      git('init -b main', vaultDir);
      git('config user.email test@test.local', vaultDir);
      git('config user.name Test', vaultDir);
      await writeFile(path.join(vaultDir, 'local-note.md'), '# Local\n\nLocal only.\n', 'utf8');
      git('add -A', vaultDir);
      git('commit -m "local init"', vaultDir);

      // 非空 bare を作成 (リモート非空)
      const nonEmpty = await makeNonEmptyBare('remote-note.md');
      bareDir = nonEmpty.bareDir;
      cloneDir = nonEmpty.cloneDir;
    });

    afterAll(async () => {
      await removeDir(vaultDir);
      await removeDir(bareDir);
      await removeDir(cloneDir).catch(() => { /* ignore */ });
    });

    it('linkEmptyOrOneSided → needsMerge=true', async () => {
      const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
      const result = await linker.linkEmptyOrOneSided(`file://${bareDir}`, 'main');
      expect(result.needsMerge).toBe(true);
    });

    it('マージは実施されていない (local-note.md のみ HEAD に存在)', () => {
      const lsTree = git('ls-tree -r --name-only HEAD', vaultDir);
      expect(lsTree).toContain('local-note.md');
      // remote-note.md は fetch されていない (merge 未実施)
      expect(lsTree).not.toContain('remote-note.md');
    });

    it('backup/pre-link-* ref が作成されている', () => {
      const branches = git('branch', vaultDir);
      expect(branches).toMatch(/backup\/pre-link-/);
    });
  });

  // ── ケース4: [ローカル空 × リモート空] → 何もしない ──

  describe('ケース4: ローカル空 × リモート空 → セットアップのみ (push/fetch なし)', () => {
    let vaultDir: string;
    let bareDir: string;

    beforeAll(async () => {
      vaultDir = await makeTempDir('loamium-vault-');
      // git init のみ (commit なし → ローカル空)
      git('init -b main', vaultDir);
      git('config user.email test@test.local', vaultDir);
      git('config user.name Test', vaultDir);

      // 空 bare
      const empty = await makeEmptyBare();
      bareDir = empty.bareDir;
    });

    afterAll(async () => {
      await removeDir(vaultDir);
      await removeDir(bareDir);
    });

    it('linkEmptyOrOneSided → ok=true, needsMerge=false', async () => {
      const linker = new InitialLinker({ vaultRoot: vaultDir, runner, audit: noop });
      const result = await linker.linkEmptyOrOneSided(`file://${bareDir}`, 'main');
      expect(result.ok).toBe(true);
      expect(result.needsMerge).toBe(false);
    });

    it('bare は空のまま (余計な push をしていない)', () => {
      // bare に main refs が存在しないことを確認
      let lsOutput = '';
      try {
        lsOutput = git(`--git-dir="${bareDir}" show-ref --heads`, vaultDir);
      } catch {
        lsOutput = ''; // show-ref は refs が無ければ exit 1
      }
      expect(lsOutput).not.toContain('main');
    });
  });
});
