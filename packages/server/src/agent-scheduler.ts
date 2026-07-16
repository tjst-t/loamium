import { CronExpressionParser } from 'cron-parser';
import { loadAgentJobs } from './agent-jobs-service.js';
import { getJobState, setJobLastRunAt } from './agent-job-state.js';
import { loadAgentConfig, createPiSession, getEffectiveCapabilities } from './agent-service.js';
import { resolvePermissions } from '@loamium/shared';
import type { ServerConfig } from './config.js';
import type { VaultIndex } from './noteIndex.js';
import type { AgentJobDefinition } from '@loamium/shared';

export const SCHEDULER_MAX_TURNS = 10;
export const SCHEDULER_TIMEOUT_MS = 300_000;

const POLL_INTERVAL_MS = 60_000;

/**
 * Compute the previous scheduled time before `now` for the given cron expression.
 * Returns null if the schedule cannot be parsed.
 */
function getPreviousScheduledTime(schedule: string, now: Date): Date | null {
  try {
    const interval = CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: now });
    return interval.prev().toDate();
  } catch {
    return null;
  }
}

/**
 * Compute the next scheduled time after `now` for the given cron expression.
 * Returns null if the schedule cannot be parsed.
 */
function getNextScheduledTime(schedule: string, now: Date): Date | null {
  try {
    const interval = CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: now });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Run a single job as an agent session (fire-and-forget).
 * Updates lastRunAt in state file after session is created.
 * Enforces maxTurns and timeoutMs defaults per ADR-0013.
 */
export async function runJobSession(
  serverConfig: ServerConfig,
  index: VaultIndex,
  job: AgentJobDefinition,
  maxTurns = SCHEDULER_MAX_TURNS,
  timeoutMs = SCHEDULER_TIMEOUT_MS,
): Promise<void> {
  const configResult = await loadAgentConfig(serverConfig.vaultRoot);
  if (!configResult.ok) {
    console.warn(`[scheduler] agent not configured, skipping job "${job.name}": ${configResult.message}`);
    return;
  }

  const jobPermissions =
    job.permission === 'append-only'
      ? (['journal_append'] as const)
      : job.permission;

  const effectiveCaps = getEffectiveCapabilities(
    configResult.config,
    resolvePermissions(jobPermissions),
    serverConfig.mode,
  );

  const runAt = new Date().toISOString();
  let session;
  try {
    session = await createPiSession(serverConfig, configResult.config, index, effectiveCaps);
  } catch (err) {
    console.error(`[scheduler] failed to create session for job "${job.name}": ${String(err)}`);
    return;
  }

  await setJobLastRunAt(serverConfig.vaultRoot, job.name, runAt);

  let abortTimer: ReturnType<typeof setTimeout> | undefined;

  const promptPromise = session.prompt(job.prompt);

  abortTimer = setTimeout(() => {
    console.warn(`[scheduler] job "${job.name}" timed out after ${timeoutMs}ms, aborting`);
    session.abort().catch(console.error);
  }, timeoutMs);

  void promptPromise
    .catch((err: unknown) => {
      console.error(`[scheduler] job "${job.name}" prompt error: ${String(err)}`);
    })
    .finally(() => {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
    });

  void maxTurns;
}

/**
 * Check all jobs and run those that need anacron catchup or are past their schedule.
 */
async function checkAndRunJobs(serverConfig: ServerConfig, index: VaultIndex): Promise<void> {
  const jobs = await loadAgentJobs(serverConfig.vaultRoot);
  const now = new Date();

  for (const job of jobs) {
    if (!job.enabled) continue;

    const { lastRunAt } = await getJobState(serverConfig.vaultRoot, job.name);
    const prevScheduled = getPreviousScheduledTime(job.schedule, now);
    if (!prevScheduled) {
      console.warn(`[scheduler] cannot parse schedule for job "${job.name}": ${job.schedule}`);
      continue;
    }

    const lastRun = lastRunAt ? new Date(lastRunAt) : null;

    const needsRun = lastRun === null || lastRun < prevScheduled;
    if (needsRun) {
      console.log(`[scheduler] running job "${job.name}" (anacron catchup or scheduled)`);
      runJobSession(serverConfig, index, job).catch(console.error);
    }
  }
}

/**
 * Schedule all enabled jobs with individual setTimeouts for their next run.
 * Returns a list of timer handles.
 */
async function scheduleNextRuns(
  serverConfig: ServerConfig,
  index: VaultIndex,
  timers: Set<ReturnType<typeof setTimeout>>,
): Promise<void> {
  const jobs = await loadAgentJobs(serverConfig.vaultRoot);
  const now = new Date();

  for (const job of jobs) {
    if (!job.enabled) continue;

    const nextRun = getNextScheduledTime(job.schedule, now);
    if (!nextRun) continue;

    const delay = nextRun.getTime() - now.getTime();
    if (delay <= 0) continue;

    const timer = setTimeout(() => {
      timers.delete(timer);
      console.log(`[scheduler] running job "${job.name}" on schedule`);
      runJobSession(serverConfig, index, job).catch(console.error);
      scheduleNextRuns(serverConfig, index, timers).catch(console.error);
    }, delay);

    timers.add(timer);
  }
}

/**
 * Start the embedded scheduler.
 *
 * - Performs anacron catchup on startup.
 * - Polls every 60 seconds for jobs that should run.
 * Returns a stop() function to clear all timers.
 */
export function startScheduler(serverConfig: ServerConfig, index: VaultIndex): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const runCatchup = (): void => {
    checkAndRunJobs(serverConfig, index).catch(console.error);
    scheduleNextRuns(serverConfig, index, timers).catch(console.error);
  };

  runCatchup();

  const pollTimer = setInterval(() => {
    if (stopped) return;
    checkAndRunJobs(serverConfig, index).catch(console.error);
  }, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(pollTimer);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
