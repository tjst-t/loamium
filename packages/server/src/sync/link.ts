/**
 * 初回リンク状態機械 — vault↔remote の初回接続を安全に自動化する (ADR-0034 / Sf17a4c-1)。
 *
 * ## 設計原則
 * - **ピュア Markdown 絶対**: ブロック ID 等の独自記法をファイルに書かない。
 * - **GIT_CEILING_DIRECTORIES**: すべての git 呼び出しに ceiling env を付与し、
 *   vault 外 (親リポジトリ) への波及を完全に封じる。
 * - SyncEngine と同じ `GitRunner` 抽象を使い、テスト注入が可能。
 * - 監査: 書き込み系操作はすべて `audit` コールバックで記録する。
 *
 * ## スコープ (Story 1)
 * - `probeRemote`: ls-remote で非空/空/到達不能を3判別
 * - `localState`: vault の git 状態 (repo か/commit ありか/ファイル数)
 * - `ensureInitialized`: 非 git vault を git init + .gitignore + .gitattributes + 初回 commit
 * - `createBackupRef`: backup/pre-link-<ts> ref を作成
 * - `linkEmptyOrOneSided`: 空×空/空×非空/非空×空 の3ケース。非空×非空は Story 2。
 *
 * ## 範囲外 (別 Story)
 * - merge-tree プレビュー / keep-both / 3-way 競合 UI (Story 2)
 * - エッジガード: 100MB 超 / 大文字小文字・NFC 衝突 / mid-merge 復元 (Story 3)
 * - REST / CLI エンドポイント (Story 4)
 * - UI ウィザード / 競合ダイアログ (Story 5)
 */
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { AuditEntry } from '@loamium/shared';
import type { GitRunner } from './git-runner.js';
import { redactGitSecrets } from './git-runner.js';

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/** `probeRemote` が返すリモート状態の3択。 */
export type RemoteState = 'empty' | 'non-empty' | 'unreachable';

/** `probeRemote` の戻り値。 */
export interface ProbeResult {
  /** リモートの状態。 */
  state: RemoteState;
  /**
   * 非空リモートのデフォルトブランチ名。HEAD 参照から取得。
   * 空または到達不能の場合は null。
   */
  defaultBranch: string | null;
  /** 到達不能の場合のエラー文字列 (redact 済み)。他は undefined。 */
  error?: string;
}

/** `localState` の戻り値。 */
export interface LocalState {
  /** vault ルート自身が git リポジトリのトップレベルか。 */
  isRepo: boolean;
  /** HEAD が存在する (少なくとも1コミットある) か。 */
  hasCommits: boolean;
  /** 追跡済み + 未追跡ファイルの概算合計数。 */
  fileCount: number;
}

/** `linkEmptyOrOneSided` の戻り値。 */
export interface LinkResult {
  /** 操作が成功したか。 */
  ok: boolean;
  /** Story 2 で処理すべき両側データあり状態。true なら merge は未実施。 */
  needsMerge: boolean;
  /** 作成された backup ref 名。マージが不要なケースでも backup が作られた場合に設定。 */
  backupRef?: string;
  /** エラーメッセージ (redact 済み)。 */
  error?: string;
}

// ──────────────────────────────────────────────
// InitialLinker
// ──────────────────────────────────────────────

/** `InitialLinker` のコンストラクタオプション。 */
export interface InitialLinkerOpts {
  /** vault のルートパス (絶対パス)。 */
  vaultRoot: string;
  /** git シェルアウト実装。テストはスタブを渡す。 */
  runner: GitRunner;
  /**
   * 監査エントリを書き込むコールバック。
   * `writeAuditEntry(config, { ts, ...entry })` の薄いラッパーを渡す。
   */
  audit: (entry: Omit<AuditEntry, 'ts'>) => Promise<void>;
}

/**
 * 初回リンク状態機械本体。
 *
 * 使い方:
 * ```ts
 * const linker = new InitialLinker({ vaultRoot, runner, audit });
 * await linker.ensureInitialized();
 * const probe = await linker.probeRemote(url);
 * const result = await linker.linkEmptyOrOneSided(url, 'main');
 * ```
 */
export class InitialLinker {
  readonly #vaultRoot: string;
  readonly #runner: GitRunner;
  readonly #audit: (entry: Omit<AuditEntry, 'ts'>) => Promise<void>;

  /**
   * GIT_CEILING_DIRECTORIES: vault の親ディレクトリを ceiling に設定することで、
   * vault が git リポジトリでない場合でも git が親へ探索を広げて誤操作するのを防ぐ。
   * SyncEngine の `#gitEnv` と完全に同一のパターン (ADR-0032 追補)。
   */
  readonly #gitEnv: Record<string, string>;

  constructor(opts: InitialLinkerOpts) {
    this.#vaultRoot = opts.vaultRoot;
    this.#runner = opts.runner;
    this.#audit = opts.audit;
    this.#gitEnv = { GIT_CEILING_DIRECTORIES: path.dirname(opts.vaultRoot) };
  }

  // ──────────────────────────────────────────
  // 内部ヘルパ
  // ──────────────────────────────────────────

  /** git コマンドを vault ルートで実行する共通ラッパ。ceiling env を必ず付与する。 */
  #run(args: string[]): ReturnType<GitRunner['run']> {
    return this.#runner.run(args, { cwd: this.#vaultRoot, env: this.#gitEnv });
  }

  /**
   * vault ルートが「それ自身の git リポジトリのトップレベル」かを検証する。
   * SyncEngine.#isVaultRepo と同じロジック — ceiling env を使うため親探索しない。
   */
  async #isVaultRepo(): Promise<boolean> {
    const res = await this.#run(['rev-parse', '--show-toplevel']);
    if (res.code !== 0) return false;
    const top = res.stdout.trim();
    if (top === '') return false;
    try {
      return realpathSync(top) === realpathSync(this.#vaultRoot);
    } catch {
      return path.resolve(top) === path.resolve(this.#vaultRoot);
    }
  }

  /**
   * vault が「別の git リポジトリの内側にネスト」しているかを検出する。
   *
   * ceiling env が `GIT_CEILING_DIRECTORIES = parent(vaultRoot)` のため、
   * vault 自身が repo でない場合 `rev-parse --show-toplevel` は必ず失敗する。
   * しかし ceiling を一時的に外して親方向の探索を確認したい場合、
   * 親ディレクトリを cwd に変えて ceiling なしで rev-parse を叩く。
   *
   * ただし InitialLinker のスコープでは「vault が repo でないのに toplevel が vault と
   * 一致しない」→ネスト、という判定で十分。 ensureInitialized 内で利用。
   */
  async #isNestedInParentRepo(): Promise<boolean> {
    // ceiling なしで親ディレクトリを cwd に rev-parse する
    const parentDir = path.dirname(this.#vaultRoot);
    const res = await this.#runner.run(['rev-parse', '--show-toplevel'], {
      cwd: parentDir,
      // ceiling を渡さない (= 親方向を探索させる)
    });
    if (res.code !== 0) return false; // 親も git repo でない
    const parentTop = res.stdout.trim();
    if (!parentTop) return false;
    // 親 top が vault より上位にある → vault は nested
    try {
      const realParentTop = realpathSync(parentTop);
      const realVault = realpathSync(this.#vaultRoot);
      // vault が parentTop の配下にある → nested
      return realVault.startsWith(realParentTop + path.sep) || realVault === realParentTop;
    } catch {
      const normParentTop = path.resolve(parentTop);
      const normVault = path.resolve(this.#vaultRoot);
      return normVault.startsWith(normParentTop + path.sep) || normVault === normParentTop;
    }
  }

  /**
   * `.gitignore` に `.loamium/` が含まれることを保証する。
   * SyncEngine.#ensureLoamiumIgnored と同じロジック (冪等)。
   */
  async #ensureLoamiumIgnored(): Promise<void> {
    const gitignorePath = path.join(this.#vaultRoot, '.gitignore');
    let existing = '';
    try {
      existing = await readFile(gitignorePath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.split('\n').some((l) => l.trim() === '.loamium/')) return;
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    await appendFile(gitignorePath, `${needsLeadingNewline ? '\n' : ''}.loamium/\n`, 'utf8');
  }

  /**
   * `.gitattributes` に `* text=auto eol=lf` が含まれることを保証する。
   * 既存ファイルがあればルールを追記し、既存ルールは上書きしない (冪等)。
   */
  async #ensureGitattributes(): Promise<void> {
    const gaPath = path.join(this.#vaultRoot, '.gitattributes');
    let existing = '';
    try {
      existing = await readFile(gaPath, 'utf8');
    } catch {
      existing = '';
    }
    const RULE = '* text=auto eol=lf';
    if (existing.split('\n').some((l) => l.trim() === RULE)) return;
    if (existing.length === 0) {
      await writeFile(gaPath, `${RULE}\n`, 'utf8');
    } else {
      const needsLeadingNewline = !existing.endsWith('\n');
      await appendFile(gaPath, `${needsLeadingNewline ? '\n' : ''}${RULE}\n`, 'utf8');
    }
  }

  /**
   * git user.name / user.email が設定されていない場合にデフォルト値を設定する。
   * commit が `*** Please tell me who you are` で失敗するのを防ぐ。
   */
  async #ensureGitUser(): Promise<void> {
    const nameRes = await this.#run(['config', 'user.name']);
    if (nameRes.code !== 0 || !nameRes.stdout.trim()) {
      await this.#run(['config', 'user.name', 'Loamium']);
    }
    const emailRes = await this.#run(['config', 'user.email']);
    if (emailRes.code !== 0 || !emailRes.stdout.trim()) {
      await this.#run(['config', 'user.email', 'loamium@localhost']);
    }
  }

  // ──────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────

  /**
   * リモート URL の状態を3択で判別する。
   *
   * `git ls-remote --exit-code <url>` の終了コード:
   * - 0: refs が返った → 非空リモート
   * - 2: refs が1つも返らなかった (空リポジトリ)
   * - その他 (128 等): 到達不能 / auth 失敗
   *
   * **重要**: exit 2 以外の非ゼロを「空」と誤認しない (ADR-0034 decision (2))。
   * auth 失敗は unreachable として中止させ、誤 push/seed を防ぐ。
   */
  async probeRemote(remoteUrl: string): Promise<ProbeResult> {
    // --exit-code: refs が1つも無ければ exit 2 を返す
    // 標準出力は refs 一覧 (TAB 区切り: <sha>\t<refname>)
    const res = await this.#runner.run(
      ['ls-remote', '--exit-code', remoteUrl],
      { cwd: this.#vaultRoot, env: this.#gitEnv },
    );

    if (res.code === 0) {
      // refs あり → 非空。HEAD → デフォルトブランチを探す
      // 例: "abc123\tHEAD"  "abc123\trefs/heads/main"
      // HEAD 行が refs/heads/<branch> を指すシンボリック行はこのコマンドでは
      // 直接解決されないので、HEAD が指す sha と refs/heads/* の sha を照合する。
      let defaultBranch: string | null = null;
      const lines = res.stdout.trim().split('\n').filter(Boolean);

      // HEAD の sha を取得
      let headSha: string | null = null;
      for (const line of lines) {
        const [sha, ref] = line.split('\t');
        if (ref === 'HEAD' && sha) {
          headSha = sha;
          break;
        }
      }

      // refs/heads/* の中で HEAD sha と一致するものをデフォルトブランチとする
      if (headSha) {
        for (const line of lines) {
          const [sha, ref] = line.split('\t');
          if (sha === headSha && ref?.startsWith('refs/heads/')) {
            defaultBranch = ref.slice('refs/heads/'.length);
            break;
          }
        }
      }

      // 照合失敗フォールバック: refs/heads/main → main の優先順
      if (!defaultBranch) {
        const fallbacks = ['main', 'master'];
        for (const fb of fallbacks) {
          if (lines.some((l) => l.split('\t')[1] === `refs/heads/${fb}`)) {
            defaultBranch = fb;
            break;
          }
        }
      }

      return { state: 'non-empty', defaultBranch: defaultBranch ?? 'main' };
    }

    if (res.code === 2) {
      // refs が1つも無い → 空リポジトリ
      return { state: 'empty', defaultBranch: null };
    }

    // その他の非ゼロ → 到達不能 / auth 失敗
    // 「空と誤認しない」: 明示的に unreachable を返す
    return {
      state: 'unreachable',
      defaultBranch: null,
      error: redactGitSecrets(res.stderr || `git ls-remote exited with code ${res.code}`),
    };
  }

  /**
   * vault の git 状態を返す。
   *
   * - `isRepo`: vault ルートが git リポジトリのトップレベルか
   * - `hasCommits`: HEAD が存在するか
   * - `fileCount`: 追跡済み + 未追跡ファイルの概算合計数
   */
  async localState(): Promise<LocalState> {
    const isRepo = await this.#isVaultRepo();
    if (!isRepo) {
      // repo でない場合はファイル数だけカウント (ls-files は使えない)
      const fileCount = await this.#countFilesInDir(this.#vaultRoot);
      return { isRepo: false, hasCommits: false, fileCount };
    }

    // HEAD の存在確認
    const headRes = await this.#run(['rev-parse', 'HEAD']);
    const hasCommits = headRes.code === 0;

    // ファイル数: 追跡済み + 未追跡 (git ls-files --others --exclude-standard)
    const trackedRes = await this.#run(['ls-files']);
    const untrackedRes = await this.#run(['ls-files', '--others', '--exclude-standard']);
    const trackedCount = trackedRes.code === 0
      ? trackedRes.stdout.trim().split('\n').filter(Boolean).length
      : 0;
    const untrackedCount = untrackedRes.code === 0
      ? untrackedRes.stdout.trim().split('\n').filter(Boolean).length
      : 0;

    return { isRepo, hasCommits, fileCount: trackedCount + untrackedCount };
  }

  /** 非 git vault でのファイル数概算 (再帰的に通常ファイルのみカウント)。 */
  async #countFilesInDir(dir: string): Promise<number> {
    const { readdir, stat } = await import('node:fs/promises');
    let count = 0;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // .loamium/ と .git/ はスキップ
        if (entry.name === '.loamium' || entry.name === '.git') continue;
        if (entry.isDirectory()) {
          count += await this.#countFilesInDir(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch {
      // 読み取り権限エラー等はカウントをスキップ
    }
    return count;
  }

  /**
   * vault を git リポジトリとして初期化する (冪等)。
   *
   * 1. vault が git repo でない場合:
   *    a. vault が別リポジトリの内側にネストしていれば throw (ADR-0032 追補)
   *    b. `git init -b main` (fallback: `git init` + branch rename)
   *    c. `.gitignore` に `.loamium/` を追記
   *    d. `.gitattributes` に `* text=auto eol=lf` を追記 (既存ルール上書きしない)
   *    e. `git user.name/email` をデフォルト設定 (未設定の場合のみ)
   *    f. `git add -A && git commit` で既存コンテンツを1スナップショットに固める
   * 2. 既に repo の場合 → 何もしない (冪等)
   *
   * @throws {Error} vault が別リポジトリの内側にネストしている場合
   * @throws {Error} git init / commit 失敗
   */
  async ensureInitialized(): Promise<void> {
    const isRepo = await this.#isVaultRepo();
    if (isRepo) return; // 既に適切に初期化済み → 冪等

    // ネスト検出: vault が親 repo の内側にある場合は拒否
    const isNested = await this.#isNestedInParentRepo();
    if (isNested) {
      throw new Error(
        `vault (${this.#vaultRoot}) は別の git リポジトリの内側にネストしています。` +
        'Loamium は親リポジトリを操作しません。vault を独立したディレクトリに移動してください。',
      );
    }

    // git init: -b main でブランチ名を指定 (git >= 2.28)
    let initResult = await this.#runner.run(['init', '-b', 'main'], {
      cwd: this.#vaultRoot,
      env: this.#gitEnv,
    });
    if (initResult.code !== 0) {
      // フォールバック: 古い git は -b オプション非対応
      initResult = await this.#runner.run(['init'], {
        cwd: this.#vaultRoot,
        env: this.#gitEnv,
      });
      if (initResult.code !== 0) {
        throw new Error(
          `git init failed (code ${initResult.code}): ${redactGitSecrets(initResult.stderr)}`,
        );
      }
      // master → main へリネーム (失敗しても続行 — git が既に main の場合 code != 0)
      await this.#run(['branch', '-m', 'master', 'main']);
    }

    // .gitignore: .loamium/ を追記
    await this.#ensureLoamiumIgnored();

    // .gitattributes: * text=auto eol=lf を追記
    await this.#ensureGitattributes();

    // git user.name/email が未設定なら Loamium デフォルトを設定
    await this.#ensureGitUser();

    // 既存コンテンツを1スナップショットとして commit
    const addResult = await this.#run(['add', '-A']);
    if (addResult.code !== 0) {
      throw new Error(
        `git add -A failed (code ${addResult.code}): ${redactGitSecrets(addResult.stderr)}`,
      );
    }

    // git status --porcelain で何もなければ空コミットを避ける
    const statusResult = await this.#run(['status', '--porcelain']);
    const hasChanges = statusResult.code === 0 && statusResult.stdout.trim() !== '';

    if (hasChanges) {
      const commitResult = await this.#run([
        'commit', '-m', 'loamium: snapshot local vault before linking',
      ]);
      if (commitResult.code !== 0) {
        throw new Error(
          `git commit failed (code ${commitResult.code}): ${redactGitSecrets(commitResult.stderr)}`,
        );
      }
    }

    await this.#audit({
      op: 'sync.link.init',
      path: this.#vaultRoot,
      mode: 'full',
      result: 'ok',
      status: 0,
    });
  }

  /**
   * 現在の HEAD から `backup/pre-link-<timestamp>` ブランチを作成する。
   * マージ/操作を実行する前に必ず呼ぶ (ADR-0034 decision (4))。
   *
   * @returns 作成した ref 名 (例: `backup/pre-link-20260726T120000000Z`)
   * @throws {Error} HEAD が存在しない (コミットがない) 場合や branch 作成失敗
   */
  async createBackupRef(): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T');
    // 例: backup/pre-link-20260726T120000000Z
    const refName = `backup/pre-link-${ts}`;

    const res = await this.#run(['branch', refName]);
    if (res.code !== 0) {
      throw new Error(
        `backup ref の作成に失敗しました (${refName}): ${redactGitSecrets(res.stderr)}`,
      );
    }

    return refName;
  }

  /**
   * リモートを設定し、空×空 / 空×非空 / 非空×空 の3ケースを処理する。
   * 非空×非空 (両側データあり) は Story 2 の管轄 — ここでは `{ needsMerge: true }` を返す。
   *
   * @param remoteUrl - リモートの URL
   * @param branch - 同期するブランチ名 (例: 'main')
   * @param remoteName - git リモート名 (デフォルト 'origin')
   */
  async linkEmptyOrOneSided(
    remoteUrl: string,
    branch: string,
    remoteName = 'origin',
  ): Promise<LinkResult> {
    // Step 1: リモートを設定 (add or set-url)
    const getUrlRes = await this.#run(['remote', 'get-url', remoteName]);
    if (getUrlRes.code === 0) {
      // 既存リモートを更新
      const setRes = await this.#run(['remote', 'set-url', remoteName, remoteUrl]);
      if (setRes.code !== 0) {
        return {
          ok: false,
          needsMerge: false,
          error: redactGitSecrets(setRes.stderr || `remote set-url failed (code ${setRes.code})`),
        };
      }
    } else {
      // 新規追加
      const addRes = await this.#run(['remote', 'add', remoteName, remoteUrl]);
      if (addRes.code !== 0) {
        return {
          ok: false,
          needsMerge: false,
          error: redactGitSecrets(addRes.stderr || `remote add failed (code ${addRes.code})`),
        };
      }
    }

    // Step 2: ローカルとリモートの状態を取得
    const local = await this.localState();
    const probe = await this.probeRemote(remoteUrl);

    if (probe.state === 'unreachable') {
      return {
        ok: false,
        needsMerge: false,
        error: probe.error ?? 'リモートに到達できません',
      };
    }

    const localHasData = local.hasCommits;
    const remoteHasData = probe.state === 'non-empty';

    // ── ケース分岐 ────────────────────────────

    if (!localHasData && !remoteHasData) {
      // [ローカル空 × リモート空]: リモート設定のみ。何も push/fetch しない
      await this.#audit({
        op: 'sync.link.init',
        path: this.#vaultRoot,
        mode: 'full',
        result: 'ok',
        status: 0,
      });
      return { ok: true, needsMerge: false };
    }

    if (!localHasData && remoteHasData) {
      // [ローカル空 × リモート非空]: fetch → checkout でリモートを採用
      // backup ref を作れないのは HEAD がないため — スキップ (backup は commit 後に意味を持つ)

      const fetchRes = await this.#run(['fetch', remoteName, branch]);
      if (fetchRes.code !== 0) {
        return {
          ok: false,
          needsMerge: false,
          error: redactGitSecrets(fetchRes.stderr || `fetch failed (code ${fetchRes.code})`),
        };
      }

      // リモートブランチを checkout してローカル追跡ブランチを作成
      const checkoutRes = await this.#run([
        'checkout', '-b', branch, `${remoteName}/${branch}`,
      ]);
      if (checkoutRes.code !== 0) {
        // 既にブランチが存在する場合のフォールバック
        const resetRes = await this.#run([
          'checkout', branch,
        ]);
        if (resetRes.code !== 0) {
          return {
            ok: false,
            needsMerge: false,
            error: redactGitSecrets(
              checkoutRes.stderr || `checkout failed (code ${checkoutRes.code})`,
            ),
          };
        }
        // ブランチを remote に追従させる
        await this.#run(['reset', '--hard', `${remoteName}/${branch}`]);
      }

      // tracking 設定
      await this.#run([
        'branch', '--set-upstream-to', `${remoteName}/${branch}`, branch,
      ]);

      await this.#audit({
        op: 'sync.link.checkout',
        path: this.#vaultRoot,
        mode: 'full',
        result: 'ok',
        status: 0,
      });
      return { ok: true, needsMerge: false };
    }

    if (localHasData && !remoteHasData) {
      // [ローカル非空 × リモート空]: commit → push でリモートを種付け
      // backup ref: HEAD があるので作成可能
      let backupRef: string | undefined;
      try {
        backupRef = await this.createBackupRef();
      } catch {
        // backup ref 作成失敗はログのみ。操作は継続 (recovery 可能)
      }

      const pushRes = await this.#runner.run(
        ['push', '-u', remoteName, `${branch}:${branch}`],
        { cwd: this.#vaultRoot, env: this.#gitEnv },
      );
      if (pushRes.code !== 0) {
        return {
          ok: false,
          needsMerge: false,
          ...(backupRef !== undefined ? { backupRef } : {}),
          error: redactGitSecrets(pushRes.stderr || `push failed (code ${pushRes.code})`),
        };
      }

      await this.#audit({
        op: 'sync.link.push',
        path: this.#vaultRoot,
        mode: 'full',
        result: 'ok',
        status: 0,
      });
      return { ok: true, needsMerge: false, ...(backupRef !== undefined ? { backupRef } : {}) };
    }

    // [ローカル非空 × リモート非空]: Story 2 の管轄 — マージ未実施
    // backup ref は作成しておく (Story 2 が使う)
    let backupRef: string | undefined;
    try {
      backupRef = await this.createBackupRef();
    } catch {
      // backup 失敗は続行 (Story 2 で再試行)
    }

    return { ok: true, needsMerge: true, ...(backupRef !== undefined ? { backupRef } : {}) };
  }
}
