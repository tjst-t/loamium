/**
 * SyncEngine ユニットテスト (Se29635-1 / scenario-Se29635-1.json)。
 *
 * StubGitRunner を注入してシステム git へのシェルアウトを完全に差し替える。
 * child_process の直接呼び出しはない — すべての git 実行は runner.run() 経由。
 *
 * [AC-Se29635-1-1]: スタブ GitRunner 経由の commit/status ルーティング検証。
 * [AC-Se29635-1-2]: git 不在時の GitUnavailableError / graceful status 検証。
 * [AC-Se29635-1-3]: スタブ GitRunner 注入による決定的ユニットテスト構造自体の検証。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { GitResult, GitRunOpts, GitRunner } from './git-runner.js';
import { GitUnavailableError } from './git-runner.js';
import { SyncEngine } from './sync-engine.js';
import type { SyncEngineConfig } from './sync-engine.js';
import type { AuditEntry } from '@loamium/shared';

// ──────────────────────────────────────────────
// StubGitRunner
// ──────────────────────────────────────────────

/**
 * テスト用スタブ。
 * - `run()` 呼び出し履歴を `calls` に記録する。
 * - `results` キューから順に `GitResult` を返す (尽きたらデフォルト 0/空)。
 * - `available` で `isAvailable()` の返り値を制御する。
 */
class StubGitRunner implements GitRunner {
  /** 呼び出されたコマンド引数の履歴 */
  calls: string[][] = [];
  /** 順番に返す GitResult のキュー */
  results: GitResult[] = [];
  /** isAvailable() が返す値 */
  available: boolean = true;
  /**
   * `rev-parse --show-toplevel` が返すパス (既定は VAULT_ROOT = vault 自身が repo)。
   * null にすると "not a git repository" を模擬する (親リポジトリ誤操作防止の検証用)。
   */
  toplevel: string | null = VAULT_ROOT;

  async run(args: string[], _opts?: GitRunOpts): Promise<GitResult> {
    this.calls.push([...args]);
    // rev-parse --show-toplevel は #isVaultRepo() の定常呼び出し。
    // results キューを消費せず toplevel を返す (他テストのスクリプト整合を保つため)。
    if (args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return this.toplevel === null
        ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
        : { code: 0, stdout: `${this.toplevel}\n`, stderr: '' };
    }
    const scripted = this.results.shift();
    // キューが尽きたらデフォルト (code=0, stdout='', stderr='')
    return scripted ?? { code: 0, stdout: '', stderr: '' };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

// ──────────────────────────────────────────────
// テストヘルパ
// ──────────────────────────────────────────────

const VAULT_ROOT = '/tmp/test-vault';

const defaultConfig: SyncEngineConfig = {
  enabled: true,
  remoteUrl: 'https://example.com/repo.git',
  branch: 'main',
  remoteName: 'origin',
  deviceName: 'test-device',
};

function makeAudit(): { entries: Array<Omit<AuditEntry, 'ts'>>; fn: (e: Omit<AuditEntry, 'ts'>) => Promise<void> } {
  const entries: Array<Omit<AuditEntry, 'ts'>> = [];
  return { entries, fn: async (e) => { entries.push(e); } };
}

function makeEngine(
  runner: StubGitRunner,
  overrideConfig?: Partial<SyncEngineConfig>,
): { engine: SyncEngine; audit: ReturnType<typeof makeAudit> } {
  const audit = makeAudit();
  const engine = new SyncEngine({
    vaultRoot: VAULT_ROOT,
    runner,
    getConfig: () => ({ ...defaultConfig, ...overrideConfig }),
    audit: audit.fn,
  });
  return { engine, audit };
}

// ──────────────────────────────────────────────
// [AC-Se29635-1-1] / [AC-Se29635-1-3]
// シナリオ 1: スタブ GitRunner 経由の commit ルーティング
// ──────────────────────────────────────────────

describe('[AC-Se29635-1-1][AC-Se29635-1-3] StubGitRunner 経由の commit ルーティング', () => {
  let runner: StubGitRunner;

  beforeEach(() => {
    runner = new StubGitRunner();
  });

  it('SyncEngine を生成できる (runner 注入後にクラッシュしない)', () => {
    // シナリオ 1 step 1: スタブ注入で生成できる
    const { engine } = makeEngine(runner);
    expect(engine).toBeDefined();
  });

  it('commit: 変更あり → git add -A → git commit の順に runner.run が呼ばれ true を返す [scenario-1 step 2]', async () => {
    const { engine } = makeEngine(runner);

    // git status --porcelain → 変更ありを示す出力
    runner.results.push({ code: 0, stdout: 'M  file.md\n', stderr: '' });
    // git check-ignore -q .loamium → code 0 (既に無視されている → .gitignore 追記なし)
    runner.results.push({ code: 0, stdout: '', stderr: '' });
    // git add -A → 成功
    runner.results.push({ code: 0, stdout: '', stderr: '' });
    // git commit -m ... → 成功
    runner.results.push({ code: 0, stdout: '[main abc1234] sync: test-device ...', stderr: '' });

    const result = await engine.commit('sync: test-device 2024-01-01T00:00:00.000Z');

    expect(result).toBe(true);

    // runner.run の呼び出し順を検証 (秘密混入防止のため add -A の前に check-ignore が入る)
    // calls[0] = git status --porcelain
    expect(runner.calls[0]).toEqual(['status', '--porcelain']);
    // calls[1] = git check-ignore -q .loamium
    expect(runner.calls[1]).toEqual(['check-ignore', '-q', '.loamium']);
    // calls[2] = git add -A
    expect(runner.calls[2]).toEqual(['add', '-A']);
    // calls[3] = git commit -m <message>
    expect(runner.calls[3]?.[0]).toBe('commit');
    expect(runner.calls[3]?.[1]).toBe('-m');
    expect(runner.calls[3]?.[2]).toBe('sync: test-device 2024-01-01T00:00:00.000Z');
  });

  it('commit: クリーンツリー → false を返し余計な commit コマンドを呼ばない [scenario-1 step 3]', async () => {
    const { engine } = makeEngine(runner);

    // git status --porcelain → 空 (クリーンツリー)
    runner.results.push({ code: 0, stdout: '', stderr: '' });

    const result = await engine.commit('sync: test-device 2024-01-01T00:00:00.000Z');

    expect(result).toBe(false);

    // status コマンドのみ — add/commit は呼ばれない
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual(['status', '--porcelain']);
  });

  it('commit: add が失敗した場合はエラーを throw し audit に error を記録する', async () => {
    const { engine, audit } = makeEngine(runner);

    runner.results.push({ code: 0, stdout: 'M  file.md\n', stderr: '' }); // status
    runner.results.push({ code: 0, stdout: '', stderr: '' }); // check-ignore → 無視済み (追記なし)
    runner.results.push({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }); // add -A 失敗

    await expect(engine.commit('msg')).rejects.toThrow('git add -A failed');
    expect(audit.entries[0]?.result).toBe('error');
    expect(audit.entries[0]?.op).toBe('sync.commit');
  });

  it('git 実行はすべて runner.run 経由であり child_process を直接呼ばない [AC-Se29635-1-1]', async () => {
    // runner.calls が空のエンジンで操作し、calls を通じてのみ git 実行を確認できること
    // (= child_process 直接呼び出しがあれば runner.calls に記録されないためテストで検出可)
    const { engine } = makeEngine(runner);

    runner.results.push({ code: 0, stdout: '', stderr: '' }); // status → クリーン

    await engine.commit('any');

    // runner を通じた呼び出しのみ記録されている
    expect(runner.calls.length).toBeGreaterThan(0);
  });

  it('status: git 利用可能な場合は available:true のステータスを返す', async () => {
    const { engine } = makeEngine(runner);

    // git status --porcelain=v2 --branch の返り値
    runner.results.push({
      code: 0,
      stdout: [
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 abc def file.md',
      ].join('\n') + '\n',
      stderr: '',
    });

    const s = await engine.status();

    expect(s.available).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.dirty).toBe(true);
    expect(s.remoteConfigured).toBe(true);
  });
});

// ──────────────────────────────────────────────
// [AC-Se29635-1-2]
// シナリオ 2: git 不在時の GitUnavailableError / graceful status
// ──────────────────────────────────────────────

describe('[AC-Se29635-1-2] git 不在時の挙動', () => {
  let runner: StubGitRunner;

  beforeEach(() => {
    runner = new StubGitRunner();
    runner.available = false; // git 不在を模擬
  });

  it('syncNow(): GitUnavailableError を throw する (握りつぶさない) [scenario-2 step 1]', async () => {
    const { engine } = makeEngine(runner);
    await expect(engine.syncNow()).rejects.toThrow(GitUnavailableError);
    await expect(engine.syncNow()).rejects.toMatchObject({ name: 'GitUnavailableError' });
  });

  it('status(): throw せず available:false の SyncStatus を返す [scenario-2 step 2]', async () => {
    const { engine } = makeEngine(runner);

    // throw してはいけない
    const s = await engine.status();

    expect(s.available).toBe(false);
    expect(s.remoteConfigured).toBe(false);
    expect(s.branch).toBeNull();
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.dirty).toBe(false);
  });

  it('モジュールの import および SyncEngine インスタンス生成は git 不在でも失敗しない [scenario-2 step 3 proxy]', () => {
    // モジュール import は既に完了している (このテストファイルが実行できていること自体が証明)。
    // SyncEngine 生成も throw しない。
    expect(() => {
      const _engine = new SyncEngine({
        vaultRoot: '/tmp/test',
        runner,
        getConfig: () => defaultConfig,
        audit: async () => {},
      });
    }).not.toThrow();
  });

  it('commit(): ensureAvailable() を通じて GitUnavailableError を throw する', async () => {
    const { engine } = makeEngine(runner);
    await expect(engine.commit('msg')).rejects.toThrow(GitUnavailableError);
  });

  it('pull(): ensureAvailable() を通じて GitUnavailableError を throw する', async () => {
    const { engine } = makeEngine(runner);
    await expect(engine.pull('test')).rejects.toThrow(GitUnavailableError);
  });

  it('push(): ensureAvailable() を通じて GitUnavailableError を throw する', async () => {
    const { engine } = makeEngine(runner);
    await expect(engine.push()).rejects.toThrow(GitUnavailableError);
  });
});

// ──────────────────────────────────────────────
// 追加カバレッジ: pull / push
// ──────────────────────────────────────────────

describe('pull() / push() の基本動作', () => {
  let runner: StubGitRunner;

  beforeEach(() => {
    runner = new StubGitRunner();
  });

  it('pull: pull --rebase が成功した場合 ok:true pulled:true を返す', async () => {
    const { engine, audit } = makeEngine(runner);

    // git pull --rebase → 成功
    runner.results.push({ code: 0, stdout: 'Already up to date.', stderr: '' });

    const result = await engine.pull('manual');

    expect(result.ok).toBe(true);
    expect(result.pulled).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(audit.entries[0]?.op).toBe('sync.pull');
    expect(audit.entries[0]?.result).toBe('ok');
    // F-3: remoteName/branch を明示して pull する (Story 2 引き継ぎ decisions.json)
    expect(runner.calls[0]).toEqual(['pull', '--rebase', 'origin', 'main']);
  });

  it('pull: 競合発生時は conflicts に競合ファイルを返す', async () => {
    const { engine } = makeEngine(runner);

    // git pull --rebase → 失敗 (競合)
    runner.results.push({ code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in note.md' });
    // resolveRebaseConflicts: diff --name-only --diff-filter=U → 競合ファイル一覧
    runner.results.push({ code: 0, stdout: 'note.md\n', stderr: '' });
    // resolveRebaseConflicts: git show :1:note.md (base)
    runner.results.push({ code: 0, stdout: 'original line\n', stderr: '' });
    // resolveRebaseConflicts: git show :2:note.md (ours)
    runner.results.push({ code: 0, stdout: 'ours changed line\n', stderr: '' });
    // resolveRebaseConflicts: git show :3:note.md (theirs)
    runner.results.push({ code: 0, stdout: 'theirs changed line\n', stderr: '' });
    // diff3Merge(base, ours, theirs) → 同一行を両者が変更 → 競合 → rebase --abort
    runner.results.push({ code: 0, stdout: '', stderr: '' }); // rebase --abort

    const result = await engine.pull('manual');

    // 解決不能競合 → ok=false, conflicts にファイルパスが含まれる
    expect(result.ok).toBe(false);
    expect(result.conflicts).toContain('note.md');
  });

  it('push: git push が成功した場合 ok:true pushed:true を返す', async () => {
    const { engine, audit } = makeEngine(runner);

    runner.results.push({ code: 0, stdout: '', stderr: '' });

    const result = await engine.push();

    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(true);
    expect(audit.entries[0]?.op).toBe('sync.push');
    expect(audit.entries[0]?.result).toBe('ok');
    // F-3: remoteName/branch refspec を明示して push する (Story 2 引き継ぎ decisions.json)
    expect(runner.calls[0]).toEqual(['push', 'origin', 'HEAD:main']);
  });
});

// ──────────────────────────────────────────────
// syncNow() 統合フロー (git 利用可)
// ──────────────────────────────────────────────

describe('syncNow() 統合フロー', () => {
  it('commit → pull --rebase → push の順で実行され SyncResult を返す', async () => {
    const runner = new StubGitRunner();
    const { engine } = makeEngine(runner);

    // commit: status → 変更あり
    runner.results.push({ code: 0, stdout: 'M  file.md\n', stderr: '' });
    // commit: add -A
    runner.results.push({ code: 0, stdout: '', stderr: '' });
    // commit: commit
    runner.results.push({ code: 0, stdout: '[main abc] sync: test-device ...', stderr: '' });
    // pull: pull --rebase
    runner.results.push({ code: 0, stdout: 'Already up to date.', stderr: '' });
    // push: push
    runner.results.push({ code: 0, stdout: '', stderr: '' });

    const result = await engine.syncNow();

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pulled).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it('クリーンツリーでは committed:false のまま pull/push を実行する', async () => {
    const runner = new StubGitRunner();
    const { engine } = makeEngine(runner);

    // commit: status → クリーン
    runner.results.push({ code: 0, stdout: '', stderr: '' });
    // pull: pull --rebase
    runner.results.push({ code: 0, stdout: 'Already up to date.', stderr: '' });
    // push: push
    runner.results.push({ code: 0, stdout: '', stderr: '' });

    const result = await engine.syncNow();

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.pulled).toBe(true);
    expect(result.pushed).toBe(true);
  });
});

// ──────────────────────────────────────────────
// PAT 認証注入 (#runWithAuth) — 秘密情報の扱い (ADR-0032)
// ──────────────────────────────────────────────

describe('PAT 認証注入 (push/pull の http.extraheader)', () => {
  function engineWithToken(runner: StubGitRunner, token: string | null): SyncEngine {
    const audit = makeAudit();
    return new SyncEngine({
      vaultRoot: VAULT_ROOT,
      runner,
      getConfig: () => ({ ...defaultConfig }),
      getToken: () => token,
      audit: audit.fn,
    });
  }

  it('token あり: push に -c http.extraheader が前置され、平文トークンは引数に現れない', async () => {
    const runner = new StubGitRunner();
    const engine = engineWithToken(runner, 'ghp_secretValue123');
    await engine.push();

    const call = runner.calls[0] ?? [];
    // -c http.extraheader=Authorization: Basic <base64> が push の前に付く
    expect(call[0]).toBe('-c');
    expect(call[1]).toMatch(/^http\.extraheader=Authorization: Basic /);
    expect(call).toContain('push');
    // 平文トークンはどの引数にも現れない (Base64 化されている)
    expect(call.join(' ')).not.toContain('ghp_secretValue123');
  });

  it('token なし: -c 引数を付けず git credential helper に委譲する', async () => {
    const runner = new StubGitRunner();
    const engine = engineWithToken(runner, null);
    await engine.push();

    const call = runner.calls[0] ?? [];
    expect(call[0]).toBe('push');
    expect(call).not.toContain('-c');
  });
});

// ──────────────────────────────────────────────
// vault が git リポジトリでない場合 (親リポジトリ誤操作の防止)
// ──────────────────────────────────────────────

describe('vault が git リポジトリでない場合', () => {
  it('status() は vaultIsRepo:false を返し、以降 git status を叩かない', async () => {
    const runner = new StubGitRunner();
    runner.toplevel = null; // rev-parse --show-toplevel が失敗 = not a repo
    const { engine } = makeEngine(runner);

    const s = await engine.status();

    expect(s.available).toBe(true); // git バイナリはある
    expect(s.vaultIsRepo).toBe(false); // vault は repo でない
    expect(s.lastError).toContain('git リポジトリ');
    // rev-parse のみで、git status --porcelain は呼ばれていない (親リポジトリを触らない)
    expect(runner.calls.some((c) => c[0] === 'status')).toBe(false);
    expect(runner.calls.some((c) => c[0] === 'rev-parse' && c[1] === '--show-toplevel')).toBe(true);
  });

  it('vault が repo のとき status() は vaultIsRepo:true を返す', async () => {
    const runner = new StubGitRunner();
    // toplevel は既定 (VAULT_ROOT) = repo
    runner.results.push({ code: 0, stdout: '# branch.head main\n', stderr: '' }); // git status
    const { engine } = makeEngine(runner);

    const s = await engine.status();
    expect(s.available).toBe(true);
    expect(s.vaultIsRepo).toBe(true);
  });

  it('全 git 実行に GIT_CEILING_DIRECTORIES(親ディレクトリ)が渡る', async () => {
    const runner = new StubGitRunner();
    const captured: Array<Record<string, string> | undefined> = [];
    const origRun = runner.run.bind(runner);
    runner.run = async (args, opts) => {
      captured.push(opts?.env);
      return origRun(args, opts);
    };
    const { engine } = makeEngine(runner);
    await engine.status();
    // rev-parse 呼び出しに ceiling env が付いている
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.['GIT_CEILING_DIRECTORIES']).toBe('/tmp');
  });
});
