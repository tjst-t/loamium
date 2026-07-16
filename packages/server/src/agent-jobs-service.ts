import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { agentJobDefinitionSchema, type AgentJobDefinition } from '@loamium/shared';

const JOBS_FILE = '.loamium/agent-jobs.json';
const STATE_FILE = '.loamium/agent-job-state.json';

export async function loadAgentJobs(vaultRoot: string): Promise<AgentJobDefinition[]> {
  const filePath = path.join(vaultRoot, JOBS_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
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

  const valid: AgentJobDefinition[] = [];
  for (const entry of parsed) {
    const result = agentJobDefinitionSchema.safeParse(entry);
    if (result.success) {
      valid.push(result.data);
    } else {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      console.warn(`[loamium] agent-jobs.json: invalid entry skipped — ${issues}`);
    }
  }
  return valid;
}

export async function getJobLastRunAt(vaultRoot: string, name: string): Promise<string | null> {
  const filePath = path.join(vaultRoot, STATE_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const state = parsed as Record<string, unknown>;
  const jobState = state[name];
  if (typeof jobState !== 'object' || jobState === null) return null;
  const lastRunAt = (jobState as Record<string, unknown>)['lastRunAt'];
  if (typeof lastRunAt !== 'string') return null;
  return lastRunAt;
}

export function computeNextRunAt(schedule: string): string | null {
  try {
    const interval = CronExpressionParser.parse(schedule, { tz: 'UTC' });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}
