/**
 * エージェント定期実行スケジューラ (S2fe109)。
 *
 * - 1 分ごとに有効ジョブをチェックし、cron 条件を満たしていれば実行する。
 * - anacron 方式: サーバー停止中に通過したスケジュール時刻があれば起動時に 1 回だけキャッチアップする。
 * - 無人実行の上限: job.timeoutSec で強制 abort / job.maxTurns でターン数制限。
 * - 同名ジョブの二重実行は防止する (実行中フラグで排他)。
 */
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import type { AgentJob, JobRunResult } from '@loamium/shared';
import { loadAgentJobs, loadJobsState, saveJobState } from './agent-jobs-store.js';
import { runAgentJob } from './agent-job-runner.js';

// ── cron パーサー ─────────────────────────────────────────────────────────────

function matchField(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.includes('/')) {
    const parts = field.split('/');
    const range = parts[0] ?? '*';
    const step = parseInt(parts[1] ?? '1', 10);
    if (range === '*') return value % step === 0;
    const start = parseInt(range, 10);
    return value >= start && (value - start) % step === 0;
  }
  if (field.includes(',')) return field.split(',').some((f) => matchField(value, f));
  if (field.includes('-')) {
    const parts = field.split('-').map(Number);
    const lo = parts[0] ?? 0;
    const hi = parts[1] ?? 0;
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

/** cron 式が特定の時刻に発火するか */
function matchesCron(date: Date, expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  const [mF, hF, dF, moF, dowF] = parts;
  if (!mF || !hF || !dF || !moF || !dowF) return false;
  return (
    matchField(date.getMinutes(), mF) &&
    matchField(date.getHours(), hF) &&
    matchField(date.getDate(), dF) &&
    matchField(date.getMonth() + 1, moF) &&
    matchField(date.getDay(), dowF)
  );
}

const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 最大 7 日分キャッチアップ

/**
 * from 〜 to の範囲内で cron 式が発火する最初の時刻を返す (なければ null)。
 * 1 分刻みで走査する。anacron は "発火があったか" の事実だけ必要なので最初の 1 件で十分。
 */
function hasCronFireInRange(expr: string, from: Date, to: Date): boolean {
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setTime(cur.getTime() + 60_000); // from より後の最初の分から開始
  while (cur <= to) {
    if (matchesCron(cur, expr)) return true;
    cur.setTime(cur.getTime() + 60_000);
  }
  return false;
}

/**
 * cron 式から次回実行予定時刻 (ISO 8601) を返す。
 * 現在時刻の 1 分後から最大 366 日先まで走査し、最初の発火時刻を返す。
 * 式が不正または発火時刻がない場合は null。
 */
export function computeNextRunAt(expr: string, from: Date = new Date()): string | null {
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setTime(cur.getTime() + 60_000); // from より後の最初の分から開始
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (cur <= limit) {
    if (matchesCron(cur, expr)) return cur.toISOString();
    cur.setTime(cur.getTime() + 60_000);
  }
  return null;
}

export { matchesCron, hasCronFireInRange };

// ── スケジューラ ──────────────────────────────────────────────────────────────

const runningJobs = new Set<string>();

async function checkScheduledJobs(
  config: ServerConfig,
  index: VaultIndex,
): Promise<void> {
  let jobs: AgentJob[];
  try {
    jobs = await loadAgentJobs(config.vaultRoot);
  } catch (err) {
    console.error(`[scheduler] agent-jobs.json 読込エラー: ${String(err)}`);
    return;
  }

  const now = new Date();
  const state = await loadJobsState(config.vaultRoot);

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (runningJobs.has(job.name)) continue; // 実行中は skip

    const jobState = state[job.name];
    const from = jobState?.lastRunAt
      ? new Date(jobState.lastRunAt)
      : new Date(now.getTime() - MAX_LOOKBACK_MS);

    if (!hasCronFireInRange(job.schedule, from, now)) continue;

    // 実行
    runningJobs.add(job.name);
    console.log(`[scheduler] job "${job.name}" 開始`);

    // 最終実行時刻を先に記録して二重キャッチアップを防ぐ
    await saveJobState(config.vaultRoot, job.name, {
      lastRunAt: now.toISOString(),
      lastResult: null,
      lastError: null,
    });

    void (async () => {
      const start = Date.now();
      let result: JobRunResult = 'ok';
      let error: string | null = null;
      try {
        ({ result, error } = await runAgentJob(config, index, job));
      } catch (err) {
        result = 'error';
        error = String(err);
      } finally {
        runningJobs.delete(job.name);
        const durationMs = Date.now() - start;
        console.log(`[scheduler] job "${job.name}" 完了: ${result} (${durationMs}ms)`);
        await saveJobState(config.vaultRoot, job.name, {
          lastRunAt: now.toISOString(),
          lastResult: result,
          lastError: error,
        }).catch((e) => console.error(`[scheduler] state 保存失敗: ${String(e)}`));
      }
    })();
  }
}

export function startScheduler(
  config: ServerConfig,
  index: VaultIndex,
): { stop: () => void } {
  // 起動時に 1 回 (anacron キャッチアップ)
  void checkScheduledJobs(config, index).catch((e) =>
    console.error(`[scheduler] 起動時チェックエラー: ${String(e)}`),
  );

  // 以降 1 分ごと
  const timer = setInterval(
    () => void checkScheduledJobs(config, index).catch((e) =>
      console.error(`[scheduler] チェックエラー: ${String(e)}`),
    ),
    60_000,
  );
  timer.unref(); // サーバー終了を妨げない

  return {
    stop: () => clearInterval(timer),
  };
}
