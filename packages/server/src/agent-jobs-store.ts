/**
 * エージェントジョブの定義と状態を永続化する。
 *
 * 定義: {vault}/.loamium/agent-jobs.json  (Git 管理対象 — ユーザーが編集する正本)
 * 状態: {vault}/.loamium/agent-jobs-state.json (使い捨て — Git 管理外)
 *   状態ファイルには最終実行時刻のみ記録し、定義ファイルと分離することで
 *   Git 差分を汚染しない (anacron 方式キャッチアップ対応)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentJobSchema, type AgentJob, type AgentJobState } from '@loamium/shared';

const JOBS_FILE = '.loamium/agent-jobs.json';
const STATE_FILE = '.loamium/agent-jobs-state.json';

export async function loadAgentJobs(vaultRoot: string): Promise<AgentJob[]> {
  const file = path.join(vaultRoot, JOBS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[loamium] agent-jobs.json: invalid JSON, skipping all entries`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[loamium] agent-jobs.json: expected array, skipping`);
    return [];
  }
  const valid: AgentJob[] = [];
  for (const entry of parsed) {
    const result = agentJobSchema.safeParse(entry);
    if (result.success) {
      valid.push(result.data);
    } else {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      console.warn(`[loamium] agent-jobs.json: invalid entry skipped — ${issues}`);
    }
  }
  return valid;
}

export type JobsState = Record<string, AgentJobState>;

export async function loadJobsState(vaultRoot: string): Promise<JobsState> {
  const file = path.join(vaultRoot, STATE_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as JobsState;
  } catch {
    return {};
  }
}

export async function saveJobState(
  vaultRoot: string,
  name: string,
  state: AgentJobState,
): Promise<void> {
  const file = path.join(vaultRoot, STATE_FILE);
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Read-modify-write (他ジョブの状態を上書きしないよう単一エントリのみ更新)
  const current = await loadJobsState(vaultRoot);
  current[name] = state;
  await fs.writeFile(file, JSON.stringify(current, null, 2), 'utf8');
}
