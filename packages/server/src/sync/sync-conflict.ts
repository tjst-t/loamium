/**
 * git rebase 競合の自動解決 (ADR-0032 / ADR-0030 / Se29635-4)。
 *
 * pull --rebase 後に競合ファイルがある場合:
 *   1. 各ファイルの 3 ステージを git show :1:path / :2:path / :3:path で読む
 *   2. diff3Merge(base, ours, theirs) を再利用して自動マージを試みる
 *   3. 全ファイル自動解決済み → ファイルを書き戻し git add → git rebase --continue
 *   4. いずれかのファイルに競合ハンクが残る → git rebase --abort (ローカル編集保護)
 *      + 未解決ハンク一覧を返す (UI へ渡す)
 *
 * DESIGN_PRINCIPLES priority 2 — ユーザーの編集は絶対に失わない:
 *   abort により rebase 前のクリーンな作業ツリーが復元され、ローカル編集が保護される。
 *   remote 側の変更は remote のまま残る (git fetch 済み)。
 *
 * @module sync-conflict
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diff3Merge, type ConflictHunk } from '@loamium/shared';
import type { GitRunner } from './git-runner.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** 解決不能な競合ハンクをファイルごとにまとめた型。 */
export interface FileConflict {
  /** 競合ファイルのパス (vault 相対) */
  file: string;
  /** diff3Merge が返した競合ハンク一覧 */
  hunks: ConflictHunk[];
}

/** resolveRebaseConflicts の戻り値 */
export type ConflictResolution =
  | { resolved: true }
  | { resolved: false; conflicts: FileConflict[] };

// ---------------------------------------------------------------------------
// 実装
// ---------------------------------------------------------------------------

/**
 * `git pull --rebase` 後の競合を diff3Merge で自動解決する。
 *
 * @param vaultRoot - vault のルートパス (絶対パス)
 * @param runner    - GitRunner インスタンス
 * @returns 全競合が自動解決された場合は `{ resolved: true }`、
 *          1 件でも未解決ハンクがある場合は `{ resolved: false, conflicts }` を返す。
 */
export async function resolveRebaseConflicts(
  vaultRoot: string,
  runner: GitRunner,
): Promise<ConflictResolution> {
  // 1. 未マージファイルの一覧を取得 (U = unmerged)
  const diffResult = await runner.run(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd: vaultRoot },
  );
  if (diffResult.code !== 0 || diffResult.stdout.trim() === '') {
    // 競合ファイルがない (rebase 成功済み or 既に abort 後) → 解決済みとして返す
    return { resolved: true };
  }

  const conflictedFiles = diffResult.stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 想定外の例外が起きても rebase を中途半端に残さない: 最終的に必ず abort する
  // ガードを張る (mid-rebase で固まると次回 pull が全て失敗する)。abort は reset --hard
  // 相当で作業ツリーも rebase 前へ復元するため、書き戻し済みファイルも安全に戻る。
  try {
    // 2. 各ファイルの 3 ステージを読み、diff3Merge を試みる
    const fileConflicts: FileConflict[] = [];
    const mergedTexts = new Map<string, string>(); // path → merged text (競合なし)

    for (const filePath of conflictedFiles) {
      // rebase 中のステージ番号は merge と逆:
      //   :1: = base (共通祖先)
      //   :2: = "ours" = rebase の onto (= リモート/upstream。HEAD が onto にある)
      //   :3: = "theirs" = 再生される自分のローカルコミット
      // したがって diff3Merge には ours=ローカル(:3:) / theirs=リモート(:2:) を渡す
      // (UI のラベル「ローカル編集」「リモート」と一致させ、編集喪失を防ぐ)。
      const [baseResult, remoteResult, localResult] = await Promise.all([
        runner.run(['show', `:1:${filePath}`], { cwd: vaultRoot }),
        runner.run(['show', `:2:${filePath}`], { cwd: vaultRoot }), // onto = remote
        runner.run(['show', `:3:${filePath}`], { cwd: vaultRoot }), // 再生 = local
      ]);

      // ステージが読めないファイル (片側 add/delete・バイナリ等) は競合として扱う
      if (baseResult.code !== 0 || remoteResult.code !== 0 || localResult.code !== 0) {
        fileConflicts.push({
          file: filePath,
          hunks: [
            {
              startLine: 0,
              endLine: 0,
              ours: localResult.stdout !== '' ? localResult.stdout.split('\n') : ['(読み取り不可)'],
              theirs: remoteResult.stdout !== '' ? remoteResult.stdout.split('\n') : ['(読み取り不可)'],
            },
          ],
        });
        continue;
      }

      // ours=ローカル(:3:), theirs=リモート(:2:)
      const result = diff3Merge(baseResult.stdout, localResult.stdout, remoteResult.stdout);
      if (result.conflicts.length === 0) {
        // 自動解決済み — マージ済みテキストを記録しておく
        mergedTexts.set(filePath, result.merged);
      } else {
        // 解決不能ハンクあり
        fileConflicts.push({ file: filePath, hunks: result.conflicts });
      }
    }

    // 3. 解決不能ハンクが 1 件でもあれば abort してローカル編集を保護
    if (fileConflicts.length > 0) {
      // abort: rebase 前のクリーンな状態に戻す (ローカル編集は失われない)
      await runner.run(['rebase', '--abort'], { cwd: vaultRoot });
      return { resolved: false, conflicts: fileConflicts };
    }

    // 4. 全ファイル自動解決 — 書き戻し → git add → git rebase --continue
    for (const [filePath, merged] of mergedTexts) {
      const absPath = path.join(vaultRoot, filePath);
      await writeFile(absPath, merged, 'utf8');
      const addResult = await runner.run(['add', filePath], { cwd: vaultRoot });
      if (addResult.code !== 0) {
        // add 失敗 → abort して安全側に倒す (abort の reset --hard で書き戻しも復元される)
        await runner.run(['rebase', '--abort'], { cwd: vaultRoot });
        return {
          resolved: false,
          conflicts: conflictedFiles.map((f) => ({
            file: f,
            hunks: [{ startLine: 0, endLine: 0, ours: [], theirs: [] }],
          })),
        };
      }
    }

    // git rebase --continue (GIT_EDITOR=true でエディタを開かせない)
    const continueResult = await runner.run(
      ['rebase', '--continue'],
      { cwd: vaultRoot, env: { GIT_EDITOR: 'true' } },
    );
    if (continueResult.code !== 0) {
      // continue 失敗 → 次コミットの競合等 → abort して安全側に倒す
      await runner.run(['rebase', '--abort'], { cwd: vaultRoot });
      return {
        resolved: false,
        conflicts: conflictedFiles.map((f) => ({
          file: f,
          hunks: [{ startLine: 0, endLine: 0, ours: [], theirs: [] }],
        })),
      };
    }

    return { resolved: true };
  } catch (err) {
    // 想定外エラー: mid-rebase を残さないよう必ず abort し、競合として返す (握りつぶさない)
    console.error('[loamium/sync] rebase 競合解決中の想定外エラー:', String(err));
    await runner.run(['rebase', '--abort'], { cwd: vaultRoot }).catch(() => {
      // abort 自体が失敗しても、これ以上できることはない (次回 pull で検出)
    });
    return {
      resolved: false,
      conflicts: conflictedFiles.map((f) => ({
        file: f,
        hunks: [{ startLine: 0, endLine: 0, ours: [], theirs: [] }],
      })),
    };
  }
}
