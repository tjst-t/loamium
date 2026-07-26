/**
 * 初回リンク状態機械 — vault↔remote の初回接続を安全に自動化する (ADR-0034 / Sf17a4c-1, 2, 3)。
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
 * ## スコープ (Story 2)
 * - `previewMerge`: git merge-tree --write-tree で作業ツリーを触らずプレビュー
 * - `applyMerge`: keep-both/local/remote/merge の解決指定でマージを適用し commit/push
 *
 * ## スコープ (Story 3)
 * - `scanLargeFiles`: >100MB ファイルを検出して警告
 * - `scanNameCollisions`: 大文字小文字・NFC/NFD 衝突パスを事前検出
 * - `quarantineCollisions`: 衝突パスを .remote 扱いで隔離 (削除しない)
 * - `removeNowIgnoredTracked`: 追跡済みで現在 ignore 対象のファイルを git rm --cached
 * - `detectMidMerge`: .git/MERGE_HEAD 等の mid-merge 状態を検出
 * - `abortMidMerge`: git merge/rebase --abort でクリーン状態に戻す
 * - `restoreFromBackup`: backup/pre-link-* ref への git reset --hard (唯一許可)
 *
 * ## 範囲外 (別 Story)
 * - REST / CLI エンドポイント (Story 4)
 * - UI ウィザード / 競合ダイアログ (Story 5)
 */
import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

/** `previewMerge` が返すマージプレビュー情報 (Story 2)。 */
export interface MergePreview {
  /** リモートにのみ存在するファイル数 (マージで自動取得)。 */
  addedFromRemote: number;
  /** ローカルにのみ存在するファイル数 (マージで自動保持)。 */
  addedFromLocal: number;
  /** 同名・別内容で衝突するファイル一覧。 */
  conflicts: Array<{ file: string }>;
  /** clean merge なら true (衝突ゼロ)。 */
  isClean: boolean;
  /**
   * Story 3: 100MB 超ファイルの警告 (Story 4/5 が UI に提示する)。
   * 省略時は警告なし (後方互換)。
   */
  warnings?: LargeFileWarning[];
  /**
   * Story 3: 大文字小文字・NFC/NFD 衝突グループ (Story 4/5 が UI に提示する)。
   * 省略時は衝突なし (後方互換)。
   */
  nameCollisions?: NameCollisionGroup[];
}

/** Story 3: `scanLargeFiles` が返すファイル情報。 */
export interface LargeFileEntry {
  /** vault 相対パス。 */
  path: string;
  /** バイト数。 */
  size: number;
}

/** Story 3: `previewMerge` が `warnings` に詰める GitHub 100MB 制限超過情報。 */
export interface LargeFileWarning {
  /** vault 相対パス。 */
  path: string;
  /** バイト数。 */
  size: number;
  /** 案内メッセージ。 */
  guidance: string;
}

/** Story 3: `scanNameCollisions` / `quarantineCollisions` で使う衝突グループ。 */
export interface NameCollisionGroup {
  /**
   * 衝突の種別。
   * - `'case'`: 大文字小文字の差異による衝突 (`note.md` ↔ `Note.md`)
   * - `'unicode'`: NFC/NFD 正規化後に同一になる衝突
   */
  kind: 'case' | 'unicode';
  /** 衝突しているパスの一覧 (2件以上)。 */
  paths: string[];
}

/** Story 3: `detectMidMerge` の戻り値。 */
export interface MidMergeState {
  /** mid-merge / mid-rebase 状態ならば true。 */
  inProgress: boolean;
  /**
   * 状態の種別。
   * - `'merge'`: `.git/MERGE_HEAD` が存在する
   * - `'rebase'`: `.git/rebase-merge` または `.git/rebase-apply` が存在する
   * - `null`: mid-merge でない
   */
  kind: 'merge' | 'rebase' | null;
}

/**
 * `applyMerge` の衝突解決指定 (Story 2)。
 *
 * - `keep-both`: ローカルはその場、リモートを `<名前>.remote.<拡張子>` に保存 (既定・最安全)
 * - `local`: ローカル側を採用
 * - `remote`: リモート側を採用
 * - `merge`: 呼び出し側が提供した `mergedText` を書き込む (3-way 統合後テキスト)
 */
export type ConflictResolution =
  | { file: string; action: 'keep-both' | 'local' | 'remote' }
  /** `merge` は 3-way 統合後テキスト必須 (型で強制)。実行時に欠落/空なら keep-both に安全フォールバック。 */
  | { file: string; action: 'merge'; mergedText: string };

// ──────────────────────────────────────────────
// Story 4 追加公開型
// ──────────────────────────────────────────────

/**
 * `linkPreview` の戻り値 (Story 4)。
 *
 * `plan`:
 * - `'noop'`: ローカル空×リモート空 — 何も変更しない
 * - `'adopt-remote'`: ローカル空×リモート非空 — リモートを採用
 * - `'seed-remote'`: ローカル非空×リモート空 — ローカルを push
 * - `'merge'`: ローカル非空×リモート非空 — マージが必要
 */
export interface LinkPreview {
  /** リモートの状態。 */
  remoteState: 'empty' | 'non-empty' | 'unreachable';
  /** ローカルの状態。 */
  local: {
    hasData: boolean;
    fileCount: number;
  };
  /** 推奨プラン。 */
  plan: 'noop' | 'adopt-remote' | 'seed-remote' | 'merge';
  /** merge / adopt-remote / seed-remote の場合のファイル件数。 */
  counts?: {
    addedFromRemote: number;
    addedFromLocal: number;
    conflicts: number;
  };
  /** merge プランの衝突ファイル一覧。 */
  conflicts?: Array<{ file: string }>;
  /** 100MB 超ファイルの警告。 */
  warnings: LargeFileWarning[];
  /** 大文字小文字・NFC/NFD 衝突グループ。 */
  nameCollisions: NameCollisionGroup[];
}

/**
 * `linkApply` の戻り値 (Story 4)。
 * `LinkResult` を拡張して `pushed` と `summary` を追加する。
 */
export interface LinkApplyResult extends LinkResult {
  /** リモートへの push が行われたか。 */
  pushed: boolean;
  /** 操作のサマリ。 */
  summary: {
    plan: 'noop' | 'adopt-remote' | 'seed-remote' | 'merge';
    pushed: boolean;
    addedFromRemote: number;
    addedFromLocal: number;
    conflictsResolved: number;
  };
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
   * `-c core.quotepath=false` を先頭に付けて git を実行する。
   * パスを stdout から読み取るコマンド (ls-tree, diff --name-only 等) で使用する。
   * core.quotepath=false により、非 ASCII パスがオクタル引用符なしで出力される。
   */
  #runQP(args: string[]): ReturnType<GitRunner['run']> {
    return this.#runner.run(
      ['-c', 'core.quotepath=false', ...args],
      { cwd: this.#vaultRoot, env: this.#gitEnv },
    );
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
        // ブランチを remote に追従させる。
        // ここは『ローカル空 × リモート非空』の adopt-remote 経路のみ (localHasData=false)
        // で到達し、破棄されるのは空スナップショットのみ = データ喪失なし。それでも念のため
        // 直前に backup ref を取り、常に復元可能にしておく (review F-6, ADR-0034 の安全側)。
        await this.createBackupRef().catch(() => undefined);
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

  // ──────────────────────────────────────────
  // Story 2: merge-tree プレビュー + keep-both/採用/3-way 適用
  // ──────────────────────────────────────────

  /**
   * `git merge-tree --write-tree --allow-unrelated-histories` で
   * **作業ツリー/インデックスを一切触らずに**マージ結果をプレビューする。
   *
   * 戻り値:
   * - `addedFromRemote`: リモートにのみ存在するファイル数
   * - `addedFromLocal`: ローカルにのみ存在するファイル数
   * - `conflicts`: 同名・別内容の衝突ファイル一覧
   * - `isClean`: 衝突ゼロなら true
   *
   * @param localRef  ローカル HEAD の ref または OID (例: 'HEAD')
   * @param remoteRef リモートの ref (例: 'origin/main')
   *
   * (AC-Sf17a4c-2-1)
   */
  async previewMerge(localRef: string, remoteRef: string): Promise<MergePreview> {
    // ── 1. merge-tree で衝突ファイルを列挙 ──
    // exit 0 = クリーン / exit 1 = 衝突あり
    // stdout 1行目: merged tree OID
    // 残行: 衝突情報 (+ 衝突パスを含む)
    const mtRes = await this.#runQP([
      'merge-tree',
      '--write-tree',
      '--allow-unrelated-histories',
      '--name-only',
      localRef,
      remoteRef,
    ]);
    // exit code 0 or 1 は正常 (0=clean, 1=conflicts); それ以外は エラー
    if (mtRes.code !== 0 && mtRes.code !== 1) {
      throw new Error(
        `git merge-tree failed (code ${mtRes.code}): ${redactGitSecrets(mtRes.stderr)}`,
      );
    }
    const isClean = mtRes.code === 0;

    // --name-only の出力フォーマット (exit 1 = 衝突あり):
    //   1行目: merged tree OID
    //   2行目〜: 衝突パス (1パス1行)
    //   空行:   セクション区切り
    //   空行以降: "Auto-merging ..." / "CONFLICT ..." などの情報メッセージ (パスではない)
    //
    // 正しいパースには「OID 行の次から最初の空行まで」を衝突パスとして取り出す。
    const rawLines = mtRes.stdout.split('\n');
    // 最初の行は tree OID をスキップ
    const linesAfterOid = rawLines.slice(1);
    // 最初の空行 (または末尾) までを衝突パスとして収集
    const conflictPaths = new Set<string>();
    for (const line of linesAfterOid) {
      if (line.trim() === '') break; // 空行でセクション終了
      conflictPaths.add(line.trim());
    }

    // ── 2. 両ツリーのファイル一覧を取得して片側のみ/衝突を判別 ──
    // core.quotepath=false で非 ASCII パスを引用符なしで取得する
    // ローカル side のファイル一覧
    const localLsRes = await this.#runQP(['ls-tree', '-r', '--name-only', localRef]);
    const localFiles = new Set<string>(
      localLsRes.code === 0
        ? localLsRes.stdout.trim().split('\n').filter(Boolean)
        : [],
    );

    // リモート side のファイル一覧
    const remoteLsRes = await this.#runQP(['ls-tree', '-r', '--name-only', remoteRef]);
    const remoteFiles = new Set<string>(
      remoteLsRes.code === 0
        ? remoteLsRes.stdout.trim().split('\n').filter(Boolean)
        : [],
    );

    // リモートにのみ存在するファイル (= マージで自動取得されるもの)
    let addedFromRemote = 0;
    for (const f of remoteFiles) {
      if (!localFiles.has(f)) addedFromRemote++;
    }

    // ローカルにのみ存在するファイル (= マージで自動保持されるもの)
    let addedFromLocal = 0;
    for (const f of localFiles) {
      if (!remoteFiles.has(f)) addedFromLocal++;
    }

    // 衝突: merge-tree が報告した衝突パス (同名・別内容)
    // merge-tree --name-only は衝突ファイルを列挙する
    const conflicts = Array.from(conflictPaths).map((file) => ({ file }));

    // ── Story 3: エッジガード情報を付加 ──
    // 100MB 超ファイルを警告として付加 (Story 4/5 が UI に提示する)
    const largeFiles = await this.scanLargeFiles();
    const warnings: LargeFileWarning[] = largeFiles.map((f) => ({
      path: f.path,
      size: f.size,
      guidance:
        `ファイル "${f.path}" (${(f.size / (1024 * 1024)).toFixed(1)} MB) は ` +
        `GitHub の 100MB ハード制限を超えています。` +
        `.gitignore に追記して追跡対象から除外するか、Git LFS の利用を検討してください。`,
    }));

    // 大文字小文字・NFC/NFD 衝突を検出 (remoteRef 指定で union 検査)
    const nameCollisions = await this.scanNameCollisions(remoteRef);

    return {
      addedFromRemote,
      addedFromLocal,
      conflicts,
      isClean,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(nameCollisions.length > 0 ? { nameCollisions } : {}),
    };
  }

  /**
   * keep-both 命名: `<base>.remote.<ext>` を基本とし、同名ファイルが存在する場合は
   * `<base>.remote-2.<ext>`, `<base>.remote-3.<ext>` と連番を付ける。
   *
   * @param filePath  元のファイルパス (例: 'メモ/買い物.md')
   * @param vaultRoot vault ルート (絶対パス)
   * @returns 衝突コピー先のパス (vault 相対)
   */
  async #keepBothRemotePath(filePath: string, vaultRoot: string): Promise<string> {
    const ext = path.extname(filePath);
    const base = ext ? filePath.slice(0, -ext.length) : filePath;

    // `<base>.remote<ext>` を試し、存在すれば連番
    let candidate = `${base}.remote${ext}`;
    let n = 2;
    while (true) {
      const abs = path.join(vaultRoot, candidate);
      try {
        await access(abs);
        // ファイルが存在する → 連番へ
        candidate = `${base}.remote-${n}${ext}`;
        n++;
      } catch {
        // アクセス不可 = 存在しない → この名前を使う
        break;
      }
    }
    return candidate;
  }

  /**
   * `git merge --allow-unrelated-histories` でマージを適用し、
   * 衝突を解決して commit → push する。
   *
   * 解決アクション:
   * - `keep-both` (既定): ローカルをその場に残し、リモートを `.remote.<ext>` に保存
   * - `local`: ローカル側を採用 (:2:)
   * - `remote`: リモート側を採用 (:3:)
   * - `merge`: 呼び出し側提供の `mergedText` を書き込む
   *
   * 解決が指定されていない衝突は自動的に `keep-both` を適用する (データ喪失ゼロ)。
   *
   * **NEVER `git reset --hard`、NEVER `-X ours/theirs`** (ADR-0034)。
   *
   * stage mapping (git merge — NOT rebase):
   * - `:2:<path>` = ours = LOCAL (current branch HEAD)
   * - `:3:<path>` = theirs = REMOTE (the merged-in side)
   *
   * @param remoteUrl  リモート URL (fetch に使う)
   * @param branch     ブランチ名 (例: 'main')
   * @param resolutions 衝突ごとの解決指定
   * @param remoteName  リモート名 (デフォルト 'origin')
   *
   * (AC-Sf17a4c-2-2, AC-Sf17a4c-2-3)
   */
  async applyMerge(
    remoteUrl: string,
    branch: string,
    resolutions: ConflictResolution[],
    remoteName = 'origin',
  ): Promise<LinkResult> {
    // ── Step 1: backup ref を必ず作成 (ADR-0034『必ず作成』) ──
    // backup が作れないまま破壊的マージへ進むと、失敗時に復元手段が無くなる。
    // よって backup 作成失敗は致命的として、マージに一切入らず中止する (review F-2)。
    let backupRef: string;
    try {
      backupRef = await this.createBackupRef();
    } catch (e) {
      return {
        ok: false,
        needsMerge: true,
        error: `バックアップ ref の作成に失敗したため初回リンクを中止しました (安全のため): ${String(e)}`,
      };
    }

    // ── Step 2: リモートを設定して fetch ──
    const getUrlRes = await this.#run(['remote', 'get-url', remoteName]);
    if (getUrlRes.code !== 0) {
      // リモートが未設定なら追加
      const addRes = await this.#run(['remote', 'add', remoteName, remoteUrl]);
      if (addRes.code !== 0) {
        return {
          ok: false,
          needsMerge: false,
          ...(backupRef !== undefined ? { backupRef } : {}),
          error: redactGitSecrets(addRes.stderr || `remote add failed (code ${addRes.code})`),
        };
      }
    } else {
      // 既存リモートを更新
      await this.#run(['remote', 'set-url', remoteName, remoteUrl]);
    }

    const fetchRes = await this.#run(['fetch', remoteName, branch]);
    if (fetchRes.code !== 0) {
      return {
        ok: false,
        needsMerge: false,
        ...(backupRef !== undefined ? { backupRef } : {}),
        error: redactGitSecrets(fetchRes.stderr || `fetch failed (code ${fetchRes.code})`),
      };
    }

    // ── Step 2b: Story 3 エッジガード (checkout/merge 前に実行) ──
    // (a) 追跡済みで現 .gitignore 対象のファイルを git rm --cached (以後の衝突防止)
    await this.removeNowIgnoredTracked().catch(() => undefined);
    // (b) 大文字小文字・NFC 衝突を隔離 (case-insensitive FS でのサイレント上書き防止)
    const collisions = await this.scanNameCollisions(`${remoteName}/${branch}`);
    if (collisions.length > 0) {
      await this.quarantineCollisions(collisions).catch(() => undefined);
    }

    await this.#audit({
      op: 'sync.link.merge',
      path: this.#vaultRoot,
      mode: 'full',
      result: 'ok',
      status: 0,
    });

    // ── Step 3: merge --no-commit --no-ff --allow-unrelated-histories ──
    // 片側だけ/同一内容は自動統合される
    // add/add 衝突は git が unmerged state にするため、その後に手動解決する
    const mergeRes = await this.#run([
      'merge',
      '--allow-unrelated-histories',
      '--no-commit',
      '--no-ff',
      `${remoteName}/${branch}`,
    ]);
    // exit 0 = clean merge (no commit needed except our --no-commit)
    // exit 1 = conflicts (also normal — we resolve below)
    // ただし CONFLICT (add/add) のケースは exit 1
    if (mergeRes.code !== 0 && mergeRes.code !== 1) {
      return {
        ok: false,
        needsMerge: false,
        ...(backupRef !== undefined ? { backupRef } : {}),
        error: redactGitSecrets(mergeRes.stderr || `merge failed (code ${mergeRes.code})`),
      };
    }

    // ── Step 4: unmerged (衝突) ファイルを検出して解決 ──
    // core.quotepath=false で非 ASCII パスを引用符なしで取得する
    // `git diff --name-only --diff-filter=U` で unmerged ファイルを列挙
    const unmergedRes = await this.#runQP(['diff', '--name-only', '--diff-filter=U']);
    if (unmergedRes.code !== 0) {
      // 列挙自体に失敗 → 衝突ゼロと誤認して conflict marker を commit するのを防ぐ。
      // マージを中止して backup へ戻せる状態のまま失敗を返す (review F-3)。
      await this.#run(['merge', '--abort']);
      return {
        ok: false,
        needsMerge: true,
        backupRef,
        error: `衝突ファイルの列挙に失敗したためマージを中止しました: ${redactGitSecrets(unmergedRes.stderr)}`,
      };
    }
    const unmergedFiles = unmergedRes.stdout.trim().split('\n').filter(Boolean);

    // resolutions を Map に変換 (ファイルパス → 解決指定)
    const resolutionMap = new Map<string, ConflictResolution>(
      resolutions.map((r) => [r.file, r]),
    );

    for (const file of unmergedFiles) {
      const resolution = resolutionMap.get(file) ?? { file, action: 'keep-both' as const };
      await this.#applyResolution(file, resolution);
    }

    // ── Step 5: commit ──
    const commitRes = await this.#run([
      'commit',
      '-m',
      'loamium: link vault to remote (conflicts resolved)',
    ]);
    if (commitRes.code !== 0) {
      // merge が既に clean で "nothing to commit" の場合もある
      const msg = commitRes.stderr + commitRes.stdout;
      const isNothingToCommit = msg.includes('nothing to commit')
        || msg.includes('nothing added to commit');
      if (!isNothingToCommit) {
        return {
          ok: false,
          needsMerge: false,
          ...(backupRef !== undefined ? { backupRef } : {}),
          error: redactGitSecrets(msg || `commit failed (code ${commitRes.code})`),
        };
      }
    }

    await this.#audit({
      op: 'sync.commit',
      path: this.#vaultRoot,
      mode: 'full',
      result: 'ok',
      status: 0,
    });

    // ── Step 6: push ──
    const pushRes = await this.#run(['push', '-u', remoteName, `${branch}:${branch}`]);
    if (pushRes.code !== 0) {
      return {
        ok: false,
        needsMerge: false,
        ...(backupRef !== undefined ? { backupRef } : {}),
        error: redactGitSecrets(pushRes.stderr || `push failed (code ${pushRes.code})`),
      };
    }

    await this.#audit({
      op: 'sync.push',
      path: this.#vaultRoot,
      mode: 'full',
      result: 'ok',
      status: 0,
    });

    return { ok: true, needsMerge: false, ...(backupRef !== undefined ? { backupRef } : {}) };
  }

  /**
   * 単一ファイルの衝突を指定アクションで解決し `git add` する。
   *
   * stage mapping (git merge — NOT rebase):
   * - `:2:<path>` = ours = LOCAL
   * - `:3:<path>` = theirs = REMOTE
   */
  async #applyResolution(file: string, resolution: ConflictResolution): Promise<void> {
    const absPath = path.join(this.#vaultRoot, file);

    switch (resolution.action) {
      case 'keep-both': {
        await this.#applyKeepBoth(file, absPath);
        break;
      }

      case 'local': {
        // ローカル (:2:) を採用
        const localContent = await this.#gitShow(`:2:${file}`);
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, localContent);
        await this.#run(['add', file]);
        break;
      }

      case 'remote': {
        // リモート (:3:) を採用
        const remoteContent = await this.#gitShow(`:3:${file}`);
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, remoteContent);
        await this.#run(['add', file]);
        break;
      }

      case 'merge': {
        // 呼び出し側が提供した mergedText を書く。
        // 実行時に mergedText が欠落/空 (REST 経由の不正入力等) の場合は、空ファイルで
        // データを失わないよう keep-both に安全フォールバックする (review F-1)。
        if (typeof resolution.mergedText === 'string' && resolution.mergedText !== '') {
          await mkdir(path.dirname(absPath), { recursive: true });
          await writeFile(absPath, resolution.mergedText, 'utf8');
          await this.#run(['add', file]);
        } else {
          await this.#applyKeepBoth(file, absPath);
        }
        break;
      }

      default: {
        // 到達しない (discriminated union) が、防御的に keep-both へ
        await this.#applyKeepBoth(file, absPath);
        break;
      }
    }
  }

  /**
   * keep-both 解決: ローカル (:2:) をその場に残し、リモート (:3:) を
   * `<名前>.remote.<拡張子>`(衝突時は連番)に書き出して両方を stage する。
   * データ喪失ゼロの安全既定。
   */
  async #applyKeepBoth(file: string, absPath: string): Promise<void> {
    const localContent = await this.#gitShow(`:2:${file}`);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, localContent);

    const remoteContent = await this.#gitShow(`:3:${file}`);
    const remotePath = await this.#keepBothRemotePath(file, this.#vaultRoot);
    const absRemotePath = path.join(this.#vaultRoot, remotePath);
    await mkdir(path.dirname(absRemotePath), { recursive: true });
    await writeFile(absRemotePath, remoteContent);

    await this.#run(['add', file, remotePath]);
  }

  /**
   * `git show <ref>` の内容をバイナリバッファで返す。
   * ステージ index 参照 (`:2:path` / `:3:path`) に使う。
   *
   * stdout は Buffer (バイナリ安全) で取得し、文字列化はせず Buffer を返す。
   * テキストファイルは writeFile でそのまま書けばよい。
   */
  async #gitShow(ref: string): Promise<Buffer> {
    // SystemGitRunner は stdout を utf8 文字列で返すが、
    // markdown は UTF-8 テキストなので文字列→Buffer 変換で十分。
    // バイナリファイル対応が必要になった場合は runner を拡張する。
    const res = await this.#run(['show', ref]);
    if (res.code !== 0) {
      throw new Error(
        `git show ${ref} failed (code ${res.code}): ${redactGitSecrets(res.stderr)}`,
      );
    }
    return Buffer.from(res.stdout, 'utf8');
  }

  // ──────────────────────────────────────────
  // Story 3: エッジガード + クラッシュ安全
  // ──────────────────────────────────────────

  /**
   * vault 作業ツリー内の >limitBytes ファイルを列挙する (Story 3 / AC-Sf17a4c-3-1)。
   *
   * `.gitignore` を尊重するため `git ls-files -o -c --exclude-standard` で
   * 追跡済み + 未追跡(ignore 対象外) のパス一覧を取得し、stat でサイズを確認する。
   * Git の 100MB ハード制限 (デフォルト limitBytes) を超えるファイルのみを返す。
   *
   * @param limitBytes - 警告閾値 (デフォルト 100MB = GitHub ハード制限)
   * @returns 超過ファイルの vault 相対パスとバイト数の一覧
   */
  async scanLargeFiles(limitBytes = 100 * 1024 * 1024): Promise<LargeFileEntry[]> {
    const { stat } = await import('node:fs/promises');

    // 追跡済みファイル + 未追跡・ignore 対象外のファイルを列挙
    // core.quotepath=false で非 ASCII パスを引用符なしで取得する
    const lsRes = await this.#runQP([
      'ls-files',
      '-c',          // cached (tracked)
      '-o',          // others (untracked, non-ignored)
      '--exclude-standard',
    ]);

    if (lsRes.code !== 0) {
      // git ls-files が使えない環境 (git init 前) では空を返す
      return [];
    }

    const filePaths = lsRes.stdout.trim().split('\n').filter(Boolean);
    const result: LargeFileEntry[] = [];

    for (const relPath of filePaths) {
      const absPath = path.join(this.#vaultRoot, relPath);
      try {
        const s = await stat(absPath);
        if (s.isFile() && s.size > limitBytes) {
          result.push({ path: relPath, size: s.size });
        }
      } catch {
        // ファイルが削除されていたなど — スキップ
      }
    }

    return result;
  }

  /**
   * 大文字小文字・NFC/NFD 衝突するパスを事前スキャンして検出する (Story 3 / AC-Sf17a4c-3-2)。
   *
   * (a) case 衝突: `toLowerCase()` 後が同一になるパスのグループ
   * (b) unicode 衝突: NFC 正規化後が同一になるパスのグループ
   *     (バイト列は異なるが正規化後は同じ — NFD → NFC の吸収)
   *
   * `remoteRef` を渡すと、ローカルのパス集合とリモートツリーのパス集合の union に対して
   * 衝突を検出する (checkout 時に case-insensitive FS が上書きする状況を事前に防ぐ)。
   *
   * @param remoteRef - リモートの ref (例: 'origin/main')。省略するとローカルのみ検査。
   * @returns 衝突グループの一覧
   */
  async scanNameCollisions(remoteRef?: string): Promise<NameCollisionGroup[]> {
    // ── ローカルのパス集合を取得 ──
    // 追跡済みファイル (HEAD が無い場合は未追跡非無視ファイルも)
    const localTrackedRes = await this.#runQP(['ls-files', '-c']);
    const localPaths = new Set<string>(
      localTrackedRes.code === 0
        ? localTrackedRes.stdout.trim().split('\n').filter(Boolean)
        : [],
    );

    // HEAD がない場合 (git init 直後・未コミット) は未追跡ファイルも含める
    const headRes = await this.#run(['rev-parse', 'HEAD']);
    if (headRes.code !== 0) {
      const untrackedRes = await this.#runQP(['ls-files', '-o', '--exclude-standard']);
      if (untrackedRes.code === 0) {
        for (const p of untrackedRes.stdout.trim().split('\n').filter(Boolean)) {
          localPaths.add(p);
        }
      }
    }

    // ── リモートのパス集合を取得 (remoteRef 指定時) ──
    const remotePaths = new Set<string>();
    if (remoteRef) {
      const remoteLsRes = await this.#runQP(['ls-tree', '-r', '--name-only', remoteRef]);
      if (remoteLsRes.code === 0) {
        for (const p of remoteLsRes.stdout.trim().split('\n').filter(Boolean)) {
          remotePaths.add(p);
        }
      }
    }

    // ── union を作って衝突検出 ──
    // 衝突検出では「ローカルのみ」「リモートのみ」「双方」すべてを考慮する。
    // ただし同一 ref からのパスの内部衝突も検出する (例: ローカル自体に case 衝突がある)。
    const allPaths = Array.from(new Set([...localPaths, ...remotePaths]));

    // (a) case 衝突: toLowerCase() 後をキーとしてグルーピング
    const caseMap = new Map<string, string[]>();
    for (const p of allPaths) {
      const key = p.toLowerCase();
      const group = caseMap.get(key) ?? [];
      group.push(p);
      caseMap.set(key, group);
    }

    // (b) unicode 衝突: NFC 正規化後をキーとしてグルーピング
    // NFC 後が同一だがバイト列が異なるパス (NFD vs NFC) を検出する
    const nfcMap = new Map<string, string[]>();
    for (const p of allPaths) {
      const key = p.normalize('NFC');
      const group = nfcMap.get(key) ?? [];
      group.push(p);
      nfcMap.set(key, group);
    }

    const result: NameCollisionGroup[] = [];

    // (a) case 衝突グループ: toLowerCase() 後が同一のパスが2件以上存在するグループ
    // 「note.md」と「Note.md」のように大文字小文字のみ異なるパスを検出する。
    // case-insensitive FS (Windows, macOS デフォルト) でサイレント上書きが発生する。
    for (const [, group] of caseMap) {
      // 2件以上かつ、バイト列として全員が同一でない (≠ 同一ファイルの重複エントリ)
      const uniquePaths = Array.from(new Set(group));
      if (uniquePaths.length >= 2) {
        result.push({ kind: 'case', paths: uniquePaths });
      }
    }

    // (b) unicode 衝突グループ: NFC 正規化後が同一だがバイト列は異なるパスが2件以上
    // 「NFD の ä」と「NFC の ä」のように正規化形式が違うだけのパスを検出する。
    // case 衝突グループと重複する場合も含む (両方の種別として報告)。
    for (const [nfcKey, group] of nfcMap) {
      // バイト列が全員 NFC 後と一致する場合は「変換不要」→ 検出しない
      const uniquePaths = Array.from(new Set(group));
      if (uniquePaths.length >= 2) {
        // 全員が既に NFC 表現である場合は「同一パス」→ スキップ
        // (例: ['note.md', 'note.md'] は同一なので報告しない)
        const notAllNFC = uniquePaths.some((p) => p !== nfcKey);
        if (notAllNFC) {
          result.push({ kind: 'unicode', paths: uniquePaths });
        }
      }
    }

    return result;
  }

  /**
   * `scanNameCollisions` が返す衝突グループを隔離する (Story 3 / AC-Sf17a4c-3-2)。
   *
   * 各グループ内で「最初のパス」をそのまま残し、残りを `.remote`-style の安全な名前に
   * rename する。ファイルは**削除しない**。rename 後に git add する。
   * 監査ログに記録する。
   *
   * @param collisions - `scanNameCollisions` の戻り値
   * @returns 隔離されたパスのペア { original, quarantined } の一覧
   */
  async quarantineCollisions(
    collisions: NameCollisionGroup[],
  ): Promise<Array<{ original: string; quarantined: string }>> {
    const quarantined: Array<{ original: string; quarantined: string }> = [];

    for (const group of collisions) {
      // グループ内の最初のパスを正規として残し、残りを隔離する
      const [, ...others] = group.paths;
      for (const originalPath of others) {
        const absOriginal = path.join(this.#vaultRoot, originalPath);
        // .remote 命名: keep-both と同じパターンを再利用
        const safePath = await this.#keepBothRemotePath(originalPath, this.#vaultRoot);
        const absSafe = path.join(this.#vaultRoot, safePath);

        try {
          await mkdir(path.dirname(absSafe), { recursive: true });
          // fs.rename でディスク上のファイルを移動してから git に通知する。
          // git mv は内部で fs.rename を行うが、対象が大文字小文字のみ異なる場合に
          // case-insensitive FS では同一ファイルと見なされ失敗することがある。
          // そのため先に fs.rename でディスクを更新し、その後 git rm/add で追跡を更新する。
          await rename(absOriginal, absSafe);

          // 追跡状態を更新: 元パスを git rm --cached → 新パスを git add
          await this.#run(['rm', '--cached', '--', originalPath]).catch(() => undefined);
          await this.#run(['add', '--', safePath]).catch(() => undefined);

          quarantined.push({ original: originalPath, quarantined: safePath });

          await this.#audit({
            op: 'sync.link.quarantine',
            path: `${originalPath} → ${safePath}`,
            mode: 'full',
            result: 'ok',
            status: 0,
          });
        } catch (e) {
          // rename 失敗はログのみ — クラッシュしない
          await this.#audit({
            op: 'sync.link.quarantine',
            path: `${originalPath} → ${safePath}`,
            mode: 'full',
            result: 'error',
            status: 1,
          });
        }
      }
    }

    return quarantined;
  }

  /**
   * 追跡済みだが現在 `.gitignore` の対象になっているファイルを
   * `git rm --cached` する (ディスク上は保持) (Story 3 / AC-Sf17a4c-3-2)。
   *
   * 典型例: `.obsidian/workspace.json` を後から `.gitignore` に追記したが
   *         既に追跡済みのため git が差分として拾い続けるケース。
   *
   * @returns `git rm --cached` したファイルのパス一覧
   */
  async removeNowIgnoredTracked(): Promise<string[]> {
    // 追跡済みファイルを列挙
    const trackedRes = await this.#runQP(['ls-files', '-c']);
    if (trackedRes.code !== 0) return [];

    const tracked = trackedRes.stdout.trim().split('\n').filter(Boolean);
    if (tracked.length === 0) return [];

    // SystemGitRunner は stdin をサポートしないため、
    // 1件ずつ check-ignore を呼ぶ方式を採用する
    const ignoredPaths: string[] = [];
    for (const filePath of tracked) {
      // --no-index: 追跡済みファイルでも .gitignore のルールに照合する
      // (通常の check-ignore は tracked ファイルをスキップする)
      // exit 0: ignore 対象 / exit 1: ignore 対象外 / exit 128: エラー
      const res = await this.#runQP(['check-ignore', '--no-index', '-q', '--', filePath]);
      if (res.code === 0) {
        ignoredPaths.push(filePath);
      }
    }

    if (ignoredPaths.length === 0) return [];

    // git rm --cached (ディスク上は保持)
    const rmRes = await this.#runQP(['rm', '--cached', '--', ...ignoredPaths]);
    if (rmRes.code !== 0) {
      // 部分的な失敗は無視して成功分を返す
      return [];
    }

    await this.#audit({
      op: 'sync.link.rm-cached',
      path: ignoredPaths.join(', '),
      mode: 'full',
      result: 'ok',
      status: 0,
    });

    return ignoredPaths;
  }

  /**
   * vault が mid-merge / mid-rebase 状態かを検出する (Story 3 / AC-Sf17a4c-3-3)。
   *
   * - `.git/MERGE_HEAD` が存在 → `{ inProgress: true, kind: 'merge' }`
   * - `.git/rebase-merge` または `.git/rebase-apply` が存在 → `{ inProgress: true, kind: 'rebase' }`
   * - それ以外 → `{ inProgress: false, kind: null }`
   *
   * git dir の絶対パスは `git rev-parse --git-dir` で取得する (`.git` ファイルに
   * なっている場合 (submodule 等) も正しく解決される)。
   */
  async detectMidMerge(): Promise<MidMergeState> {
    const gitDirRes = await this.#run(['rev-parse', '--git-dir']);
    if (gitDirRes.code !== 0) {
      // git リポジトリでない → mid-merge でない
      return { inProgress: false, kind: null };
    }

    // git rev-parse --git-dir は相対パスを返すことがある → 絶対パスに変換
    const rawGitDir = gitDirRes.stdout.trim();
    const gitDir = path.isAbsolute(rawGitDir)
      ? rawGitDir
      : path.join(this.#vaultRoot, rawGitDir);

    const { stat } = await import('node:fs/promises');

    // MERGE_HEAD の存在確認
    try {
      await stat(path.join(gitDir, 'MERGE_HEAD'));
      return { inProgress: true, kind: 'merge' };
    } catch {
      // 存在しない → 次のチェックへ
    }

    // rebase-merge の存在確認
    try {
      await stat(path.join(gitDir, 'rebase-merge'));
      return { inProgress: true, kind: 'rebase' };
    } catch {
      // 存在しない → 次のチェックへ
    }

    // rebase-apply の存在確認
    try {
      await stat(path.join(gitDir, 'rebase-apply'));
      return { inProgress: true, kind: 'rebase' };
    } catch {
      // 存在しない
    }

    return { inProgress: false, kind: null };
  }

  /**
   * mid-merge / mid-rebase を中止してクリーン状態に戻す (Story 3 / AC-Sf17a4c-3-3)。
   *
   * - merge 中: `git merge --abort`
   * - rebase 中: `git rebase --abort`
   *
   * @throws {Error} abort に失敗した場合
   */
  async abortMidMerge(): Promise<void> {
    const state = await this.detectMidMerge();
    if (!state.inProgress) {
      throw new Error('mid-merge 状態ではありません。abort の実行は不要です。');
    }

    if (state.kind === 'merge') {
      const res = await this.#run(['merge', '--abort']);
      if (res.code !== 0) {
        throw new Error(
          `git merge --abort failed (code ${res.code}): ${redactGitSecrets(res.stderr)}`,
        );
      }
    } else if (state.kind === 'rebase') {
      const res = await this.#run(['rebase', '--abort']);
      if (res.code !== 0) {
        throw new Error(
          `git rebase --abort failed (code ${res.code}): ${redactGitSecrets(res.stderr)}`,
        );
      }
    }

    await this.#audit({
      op: 'sync.link.abort',
      path: this.#vaultRoot,
      mode: 'full',
      result: 'ok',
      status: 0,
    });
  }

  // ──────────────────────────────────────────
  // Story 4: 高レベルオーケストレーション (REST / CLI 向け)
  // ──────────────────────────────────────────

  /**
   * ADR-0034 状態機械の **プレビューエントリポイント** (Story 4 / AC-Sf17a4c-4-1)。
   *
   * 1. `ensureInitialized()` — 冪等 git init + スナップショット (作業ツリーに永続変更はしない)
   * 2. リモートを設定/更新して `fetch`
   * 3. `probeRemote` + `localState` で3判別
   * 4. local×remote 双方データありの場合のみ `previewMerge` で件数/衝突を算出
   *
   * **プレビューは push しない。作業ツリーを変更しない (merge-tree は dry-run)**。
   * auto-init (git init + スナップショットコミット) と backup ref 作成は行う —
   * これらは可逆操作 (backup から復元できる) であり、ADR-0034 の『reversible auto-init』。
   *
   * @param remoteUrl - リモート URL
   * @param branch    - ブランチ名 (省略時は 'main')
   * @param remoteName - git リモート名 (デフォルト 'origin')
   */
  async linkPreview(
    remoteUrl: string,
    branch = 'main',
    remoteName = 'origin',
  ): Promise<LinkPreview> {
    // Step 1: 冪等 init (既に repo なら何もしない)
    await this.ensureInitialized();

    // Step 2: リモートを設定/更新
    const getUrlRes = await this.#run(['remote', 'get-url', remoteName]);
    if (getUrlRes.code === 0) {
      await this.#run(['remote', 'set-url', remoteName, remoteUrl]);
    } else {
      const addRes = await this.#run(['remote', 'add', remoteName, remoteUrl]);
      if (addRes.code !== 0) {
        throw new Error(
          `remote add failed (code ${addRes.code}): ${redactGitSecrets(addRes.stderr)}`,
        );
      }
    }

    // Step 3: probe + localState
    const probe = await this.probeRemote(remoteUrl);
    const local = await this.localState();

    if (probe.state === 'unreachable') {
      throw new Error(
        `リモートに到達できません: ${probe.error ?? 'unreachable'}`,
      );
    }

    const localHasData = local.hasCommits;
    const remoteHasData = probe.state === 'non-empty';

    // Step 4: プラン判別
    if (!localHasData && !remoteHasData) {
      // noop: 空×空
      return {
        remoteState: probe.state,
        local: { hasData: localHasData, fileCount: local.fileCount },
        plan: 'noop',
        warnings: [],
        nameCollisions: [],
      };
    }

    if (!localHasData && remoteHasData) {
      // adopt-remote: 空×非空
      // fetch してリモートのファイル数を取得 (プレビュー専用)
      await this.#run(['fetch', remoteName, branch]);
      const remoteLsRes = await this.#runQP(['ls-tree', '-r', '--name-only', `${remoteName}/${branch}`]);
      const remoteFileCount = remoteLsRes.code === 0
        ? remoteLsRes.stdout.trim().split('\n').filter(Boolean).length
        : 0;
      const warnings = await this.#buildLargeFileWarnings();
      const nameCollisions = await this.scanNameCollisions(`${remoteName}/${branch}`);
      return {
        remoteState: probe.state,
        local: { hasData: false, fileCount: local.fileCount },
        plan: 'adopt-remote',
        counts: { addedFromRemote: remoteFileCount, addedFromLocal: 0, conflicts: 0 },
        warnings,
        nameCollisions,
      };
    }

    if (localHasData && !remoteHasData) {
      // seed-remote: 非空×空
      const warnings = await this.#buildLargeFileWarnings();
      const nameCollisions = await this.scanNameCollisions();
      return {
        remoteState: probe.state,
        local: { hasData: true, fileCount: local.fileCount },
        plan: 'seed-remote',
        counts: { addedFromRemote: 0, addedFromLocal: local.fileCount, conflicts: 0 },
        warnings,
        nameCollisions,
      };
    }

    // merge: 非空×非空 — merge-tree dry-run
    await this.#run(['fetch', remoteName, branch]);
    const preview = await this.previewMerge('HEAD', `${remoteName}/${branch}`);
    return {
      remoteState: probe.state,
      local: { hasData: true, fileCount: local.fileCount },
      plan: 'merge',
      counts: {
        addedFromRemote: preview.addedFromRemote,
        addedFromLocal: preview.addedFromLocal,
        conflicts: preview.conflicts.length,
      },
      conflicts: preview.conflicts,
      warnings: preview.warnings ?? [],
      nameCollisions: preview.nameCollisions ?? [],
    };
  }

  /** `previewMerge` 用の大ファイル警告ビルダー (local ファイルのみスキャン)。 */
  async #buildLargeFileWarnings(): Promise<LargeFileWarning[]> {
    const largeFiles = await this.scanLargeFiles();
    return largeFiles.map((f) => ({
      path: f.path,
      size: f.size,
      guidance:
        `ファイル "${f.path}" (${(f.size / (1024 * 1024)).toFixed(1)} MB) は ` +
        `GitHub の 100MB ハード制限を超えています。` +
        `.gitignore に追記して追跡対象から除外するか、Git LFS の利用を検討してください。`,
    }));
  }

  /**
   * ADR-0034 状態機械の **適用エントリポイント** (Story 4 / AC-Sf17a4c-4-1)。
   *
   * プレビューと同じ3判別を行い、プランに応じて完了まで実行する:
   * - noop: 何もしない
   * - adopt-remote: リモートを checkout
   * - seed-remote: ローカルを push
   * - merge: resolutions を渡して `applyMerge`
   *
   * すべてのケースで backup ref を作成してから操作を実行する。
   * 監査エントリ `sync.link.preview` / `sync.link.apply` を記録する。
   *
   * @param remoteUrl   - リモート URL
   * @param resolutions - 衝突解決指定 (merge プランのみ使用)
   * @param branch      - ブランチ名 (省略時は 'main')
   * @param remoteName  - git リモート名 (デフォルト 'origin')
   */
  async linkApply(
    remoteUrl: string,
    resolutions: ConflictResolution[],
    branch = 'main',
    remoteName = 'origin',
  ): Promise<LinkApplyResult> {
    // Step 1: 冪等 init
    await this.ensureInitialized();

    // Step 2: リモートを設定/更新
    const getUrlRes = await this.#run(['remote', 'get-url', remoteName]);
    if (getUrlRes.code === 0) {
      await this.#run(['remote', 'set-url', remoteName, remoteUrl]);
    } else {
      const addRes = await this.#run(['remote', 'add', remoteName, remoteUrl]);
      if (addRes.code !== 0) {
        throw new Error(
          `remote add failed (code ${addRes.code}): ${redactGitSecrets(addRes.stderr)}`,
        );
      }
    }

    // Step 3: probe + localState
    const probe = await this.probeRemote(remoteUrl);
    const local = await this.localState();

    if (probe.state === 'unreachable') {
      throw new Error(
        `リモートに到達できません: ${probe.error ?? 'unreachable'}`,
      );
    }

    const localHasData = local.hasCommits;
    const remoteHasData = probe.state === 'non-empty';

    // Step 4: 実際のブランチ名を決定 (probe defaultBranch を優先)
    const effectiveBranch = branch;

    await this.#audit({
      op: 'sync.link.apply',
      path: this.#vaultRoot,
      mode: 'full',
      result: 'ok',
      status: 0,
    });

    // Step 5: プランに応じて実行
    if (!localHasData && !remoteHasData) {
      return {
        ok: true,
        needsMerge: false,
        pushed: false,
        summary: {
          plan: 'noop',
          pushed: false,
          addedFromRemote: 0,
          addedFromLocal: 0,
          conflictsResolved: 0,
        },
      };
    }

    if (!localHasData || !remoteHasData) {
      // adopt-remote か seed-remote — linkEmptyOrOneSided が処理する
      const linkResult = await this.linkEmptyOrOneSided(remoteUrl, effectiveBranch, remoteName);
      if (!linkResult.ok) {
        throw new Error(linkResult.error ?? 'initial link failed');
      }

      // ローカル非空×リモート空 → seed-remote (push した)
      // ローカル空×リモート非空 → adopt-remote (checkout した)
      const plan: 'adopt-remote' | 'seed-remote' = (!localHasData && remoteHasData)
        ? 'adopt-remote'
        : 'seed-remote';

      const addedFromRemote = plan === 'adopt-remote' ? local.fileCount : 0;
      const addedFromLocal = plan === 'seed-remote' ? local.fileCount : 0;

      return {
        ok: true,
        needsMerge: false,
        pushed: plan === 'seed-remote',
        ...(linkResult.backupRef !== undefined ? { backupRef: linkResult.backupRef } : {}),
        summary: {
          plan,
          pushed: plan === 'seed-remote',
          addedFromRemote,
          addedFromLocal,
          conflictsResolved: 0,
        },
      };
    }

    // merge: 非空×非空
    // fetch は applyMerge 内で行う。resolutions を渡す。
    const mergeResult = await this.applyMerge(remoteUrl, effectiveBranch, resolutions, remoteName);
    if (!mergeResult.ok) {
      throw new Error(mergeResult.error ?? 'merge failed');
    }

    return {
      ok: true,
      needsMerge: false,
      pushed: true,
      ...(mergeResult.backupRef !== undefined ? { backupRef: mergeResult.backupRef } : {}),
      summary: {
        plan: 'merge',
        pushed: true,
        addedFromRemote: 0, // applyMerge は個別カウントを返さないため 0 (preview で提示済み)
        addedFromLocal: 0,
        conflictsResolved: resolutions.length,
      },
    };
  }

  /**
   * `backup/pre-link-*` ref へ `git reset --hard` する (Story 3 / AC-Sf17a4c-3-3)。
   *
   * **これは InitialLinker 内で唯一許可される `reset --hard` 呼び出し**。
   * ユーザーが明示的に「リンク前状態に戻す」を選択した場合のみ実行する。
   *
   * セーフガード: `backupRef` が `backup/pre-link-` で始まらない場合は拒否する。
   * これにより、リモート ref や任意コミットへの誤 reset を防ぐ。
   *
   * @param backupRef - `backup/pre-link-*` 形式の ref 名
   * @throws {Error} ref 名が不正、または reset 失敗の場合
   */
  async restoreFromBackup(backupRef: string): Promise<void> {
    // セーフガード: backup/pre-link-* のみ許可
    if (!backupRef.startsWith('backup/pre-link-')) {
      throw new Error(
        `restoreFromBackup は backup/pre-link-* ref のみ受け付けます。` +
        `渡された ref: "${backupRef}" は不正です (リモートや任意コミットへの誤操作を防ぐ)。`,
      );
    }

    // ref が実際に存在するか確認
    const verifyRes = await this.#run(['rev-parse', '--verify', backupRef]);
    if (verifyRes.code !== 0) {
      throw new Error(
        `backup ref が存在しません: "${backupRef}". ` +
        `createBackupRef で事前に作成されていることを確認してください。`,
      );
    }

    const resetRes = await this.#run(['reset', '--hard', backupRef]);
    if (resetRes.code !== 0) {
      throw new Error(
        `git reset --hard ${backupRef} failed (code ${resetRes.code}): ${redactGitSecrets(resetRes.stderr)}`,
      );
    }

    await this.#audit({
      op: 'sync.link.restore',
      path: `${this.#vaultRoot} → ${backupRef}`,
      mode: 'full',
      result: 'ok',
      status: 0,
    });
  }
}
